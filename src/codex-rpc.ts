import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import type { Config } from './config.js';

export function codexLaunch(command: string) {
  if (/\.[cm]?js$/i.test(command)) return { command: process.execPath, args: [command] };
  if (command !== 'codex' || process.platform !== 'win32') return { command, args: [] as string[] };
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const exe = path.join(directory, 'codex.exe');
    if (fs.existsSync(exe)) return { command: exe, args: [] as string[] };
    const script = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(script)) return { command: process.execPath, args: [script] };
  }
  throw new Error('没有找到 Codex CLI。请安装 Codex CLI，或配置 LABOR_CODEX_COMMAND 为 codex.exe/codex.js 的路径。');
}

export class CodexRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private serial = 0;
  private opening?: Promise<void>;
  private closed = false;
  constructor(private config: Config, readonly home: string) { super(); }
  start() {
    return this.opening ||= this.open();
  }
  private async open() {
    const launch = codexLaunch(this.config.codexCommand);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/API_?KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
    env.CODEX_HOME = this.home; env.CODEX_SQLITE_HOME = this.config.codexSqliteHome;
    if (this.config.codexDirect) for (const key of Object.keys(env)) if (/^(all|https?)_proxy$/i.test(key)) delete env[key];
    this.child = spawn(launch.command, [...launch.args, 'app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}'], {
      cwd: this.config.projectRoot, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Do not forward raw process logs: authentication material stays server-side.
    this.child.stderr.on('data', () => {});
    this.child.on('error', error => this.fail(new Error(`Codex 无法启动：${error.message}`)));
    this.child.on('exit', () => { this.closed = true; this.fail(new Error('Codex 连接已关闭。')); });
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      let message: any; try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (message.id !== undefined && pending) {
        clearTimeout(pending.timer); this.pending.delete(message.id);
        message.error ? pending.reject(new Error(message.error.message || 'Codex 请求失败。')) : pending.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        // Permission requests and interactive questions must not hang silently.
        // The runner stops the turn and exposes a question to the coordinator.
        this.emit('serverRequest', message);
        this.reply(message.id, { code: -32601, message: 'Interactive request requires coordinator input; turn interrupted.' });
      } else if (message.method) this.emit('notification', message.method, message.params || {});
    });
    await this.request('initialize', { clientInfo: { name: 'labor_agent', title: 'Labor Agent', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }
  private reply(id: unknown, error: unknown) {
    if (!this.closed) this.child?.stdin.write(JSON.stringify({ id, error }) + '\n');
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('disconnected', error);
  }
  request(method: string, params: unknown = {}, timeout = 30000): Promise<any> {
    if (this.closed || !this.child) return Promise.reject(new Error('Codex 尚未连接。'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex 请求超时：${method}`)); }, timeout);
      timer.unref(); this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  close() { this.closed = true; this.fail(new Error('Codex 连接已关闭。')); this.child?.stdin.end(); this.child?.kill(); }
}
