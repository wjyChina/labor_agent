import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { z } from 'zod';
import type { Config } from './config.js';
import { atomicWrite } from './store.js';

const MAX_TEXT = 24000;
const schemas = {
  read: z.object({ path: z.string().min(1), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(2000).optional() }).strict(),
  write: z.object({ path: z.string().min(1), content: z.string().max(2_000_000), overwrite: z.boolean().optional() }).strict(),
  edit: z.object({ path: z.string().min(1), old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().optional() }).strict(),
  bash: z.object({ command: z.string().min(1).max(100000), timeout_ms: z.number().int().min(100).max(300000).optional() }).strict(),
  tool_result_get: z.object({ result_id: z.string().uuid(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(8000).optional() }).strict(),
};
const field = (type: string, description: string) => ({ type, description });
function definition(name: string, description: string, properties: object, required: string[]) {
  return { type: 'function', name, description, strict: false,
    parameters: { type: 'object', properties, required, additionalProperties: false } };
}
export const toolDefinitions = [
  definition('read', 'Read a UTF-8 file with line numbers, or list a directory. Paths are relative to the session workspace.', {
    path: field('string', 'File or directory path'), offset: field('integer', 'First line, 1-based; default 1'), limit: field('integer', 'Maximum lines; default 80, maximum 2000. Read only the relevant range.'),
  }, ['path']),
  definition('write', 'Create a UTF-8 file. Existing files require overwrite=true. Creates parent directories.', {
    path: field('string', 'File path'), content: field('string', 'Complete file contents'), overwrite: field('boolean', 'Explicitly allow overwriting an existing file; default false'),
  }, ['path', 'content']),
  definition('edit', 'Replace an exact string in an existing UTF-8 file. Read it first. Rejects ambiguous matches unless replace_all=true. Preserves line endings.', {
    path: field('string', 'File path'), old_text: field('string', 'Exact nonempty original text'), new_text: field('string', 'Replacement text'), replace_all: field('boolean', 'Replace every match; default false'),
  }, ['path', 'old_text', 'new_text']),
  definition('bash', 'Execute a Bash command in the session workspace. Real OS access, not a sandbox. Use for search, tests and builds. Output is bounded; timeout defaults to 60s (maximum 300s).', {
    command: field('string', 'Bash command'), timeout_ms: field('integer', 'Timeout in milliseconds'),
  }, ['command']),
  definition('tool_result_get', 'Read a page of a captured tool result from this session by result_id returned in a preview. Do not rerun commands to recover output. Capture limits still apply.', {
    result_id: field('string', 'Result ID from a tool preview'), offset: field('integer', 'Character offset, 0-based; default 0'),
    limit: field('integer', 'Maximum text characters; default 4000, maximum 8000'),
  }, ['result_id']),
];

export function clip(s: string, max = MAX_TEXT) {
  return s.length > max ? `${s.slice(0, max)}\n… [输出已截断，共 ${s.length} 字符]` : s;
}
export function isWithin(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export class ToolExecutor {
  bashPath: string;
  private locks = new Map<string, Promise<unknown>>();
  constructor(private config: Config) {
    const choices = process.platform === 'win32'
      ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe', path.join(process.env.LOCALAPPDATA || '', 'Programs/Git/bin/bash.exe')]
      : ['/bin/bash', '/usr/bin/bash'];
    this.bashPath = config.bashPath || choices.find(p => fs.existsSync(p)) || 'bash';
  }
  private resolve(root: string, requested: string) {
    const base = fs.realpathSync(root);
    const target = path.resolve(base, requested);
    if (!isWithin(base, target)) throw new Error('文件路径超出了当前会话的工作目录。');
    // Follow the nearest existing ancestor to reject symlink/junction escapes on creates too.
    let parent = target;
    while (!fs.existsSync(parent)) {
      const next = path.dirname(parent);
      if (parent === next) throw new Error('无法解析文件路径。');
      parent = next;
    }
    if (!isWithin(base, fs.realpathSync(parent))) throw new Error('不允许通过符号链接访问工作目录之外的文件。');
    const realTarget = path.resolve(fs.realpathSync(parent), path.relative(parent, target));
    if (path.basename(target).toLowerCase().startsWith('.env') || path.basename(realTarget).toLowerCase().startsWith('.env') ||
        isWithin(this.config.dataDir, target) || isWithin(this.config.dataDir, realTarget) ||
        target.toLowerCase() === path.join(this.config.projectRoot, '.env').toLowerCase() ||
        realTarget.toLowerCase() === path.join(this.config.projectRoot, '.env').toLowerCase())
      throw new Error('文件工具不读取或修改 .env / agent 内部数据。');
    return target;
  }
  async execute(name: string, args: unknown, root: string, signal: AbortSignal,
    readResult?: (id: string) => string): Promise<string> {
    signal.throwIfAborted();
    if (!(name in schemas)) throw new Error(`未知工具：${name}`);
    if (name === 'tool_result_get') {
      const a = schemas.tool_result_get.parse(args);
      if (!readResult) throw new Error('当前工具调用没有关联会话。');
      const text = readResult(a.result_id), offset = a.offset ?? 0, limit = a.limit ?? 4000;
      if (offset > text.length) throw new Error(`offset 超出结果长度（${text.length} 字符）。`);
      const page = text.slice(offset, offset + limit), next = offset + page.length;
      return JSON.stringify({ result_id: a.result_id, offset, total_chars: text.length, text: page,
        has_more: next < text.length, ...(next < text.length ? { next_offset: next } : {}) });
    }
    if (name === 'bash') {
      const a = schemas.bash.parse(args);
      return this.bash(a.command, root, a.timeout_ms || 60000, signal);
    }
    const a = schemas[name as keyof typeof schemas].parse(args) as any;
    const target = this.resolve(root, a.path);
    // Serialize file operations across sessions so an edit never races another edit.
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    const prior = this.locks.get(key) || Promise.resolve();
    const work = prior.catch(() => {}).then(() => {
      signal.throwIfAborted(); this.resolve(root, a.path);
      if (name === 'read') {
        if (fs.statSync(target).isDirectory()) return clip(fs.readdirSync(target, { withFileTypes: true })
          .map(e => `${e.isDirectory() ? '[dir] ' : ''}${e.name}`).sort().join('\n'));
        if (fs.statSync(target).size > 4_000_000) throw new Error('文件超过 4 MB，请使用 bash 按需读取。');
        const content = fs.readFileSync(target, 'utf8');
        if (content.includes('\0')) throw new Error('这不是 UTF-8 文本文件。');
        const lines = content.split(/\r?\n/), start = (a.offset || 1) - 1;
        return clip(lines.slice(start, start + (a.limit || 80)).map((line, i) => `${start + i + 1}: ${line}`).join('\n')) + `\n[共 ${lines.length} 行]`;
      }
      if (name === 'write') {
        if (fs.existsSync(target) && !a.overwrite) throw new Error('文件已存在；覆盖需要 overwrite=true。');
        atomicWrite(target, a.content); return `已写入 ${a.path}（${Buffer.byteLength(a.content)} 字节）`;
      }
      if (fs.statSync(target).size > 4_000_000) throw new Error('文件超过 4 MB，无法直接编辑。');
      const original = fs.readFileSync(target, 'utf8');
      const eol = original.includes('\r\n') ? '\r\n' : '\n';
      const oldText = a.old_text.replace(/\r?\n/g, eol), newText = a.new_text.replace(/\r?\n/g, eol);
      const count = original.split(oldText).length - 1;
      if (!count) throw new Error('old_text 没有匹配，请重新读取文件。');
      if (count > 1 && !a.replace_all) throw new Error(`匹配到 ${count} 处；请增加上下文或设置 replace_all=true。`);
      atomicWrite(target, a.replace_all ? original.split(oldText).join(newText) : original.replace(oldText, () => newText));
      return `已编辑 ${a.path}（替换 ${a.replace_all ? count : 1} 处）`;
    });
    this.locks.set(key, work);
    try { return await work; }
    finally { if (this.locks.get(key) === work) this.locks.delete(key); }
  }
  private bash(command: string, root: string, timeout: number, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const env = { ...process.env };
      // The model's shell does not need inherited provider credentials.
      for (const key of Object.keys(env)) if (/API_?KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
      delete env.BASH_ENV; delete env.ENV;
      const child = spawn(this.bashPath, ['--noprofile', '--norc', '-c', command], {
        cwd: root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', truncated = false, reason = '';
      const append = (current: string, chunk: string) => {
        const combined = current + chunk;
        if (combined.length <= MAX_TEXT) return combined;
        truncated = true;
        return combined.slice(0, MAX_TEXT / 2) + combined.slice(-MAX_TEXT / 2);
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', s => { stdout = append(stdout, s); });
      child.stderr.on('data', s => { stderr = append(stderr, s); });
      const kill = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      };
      const abort = () => { reason = '命令已取消'; kill(); };
      const timer = setTimeout(() => { reason = `命令超时（${timeout}ms）`; kill(); }, timeout);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      child.on('error', e => { cleanup(); reject(new Error(`无法运行 Bash（${this.bashPath}）：${e.message}`)); });
      child.on('close', (code, sig) => {
        cleanup();
        const result = JSON.stringify({ exit_code: code, signal: sig, stdout, stderr, truncated,
          ...(truncated ? { truncation: 'head_tail' } : {}), ...(reason ? { error: reason } : {}) });
        if (signal.aborted) reject(new Error('命令已取消'));
        else resolve(result);
      });
    });
  }
}
