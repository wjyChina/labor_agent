import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export type ApiItem = Record<string, any>;
export type Message = {
  id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string;
  time: string; source?: 'mcp' | 'web'; tool?: string; args?: unknown;
  state?: 'running' | 'done' | 'error' | 'skipped';
  kind?: 'guidance'; delivery?: 'queued' | 'applied';
};
export type Session = {
  id: string; title: string; workspace: string; createdAt: string; updatedAt: string;
  status: 'idle' | 'running' | 'error' | 'cancelled';
  messages: Message[]; history: ApiItem[]; previousResponseId?: string;
  responseCursor?: number; providerKey?: string; error?: string;
  usage: { input: number; output: number; cached: number };
};

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export const now = () => new Date().toISOString();

export function atomicWrite(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const mode = fs.existsSync(file) ? fs.statSync(file).mode : 0o600;
  try { fs.writeFileSync(temp, text, { mode }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export class Store extends EventEmitter {
  sessions = new Map<string, Session>();
  activeSessionId: string | null = null;
  constructor(public dir: string) {
    super();
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    for (const name of fs.readdirSync(path.join(dir, 'sessions')).filter(n => n.endsWith('.json'))) {
      // Fail visibly on corruption rather than silently losing a conversation.
      const s: Session = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', name), 'utf8'));
      if (!s.id || !Array.isArray(s.history) || !Array.isArray(s.messages))
        throw new Error(`损坏的会话文件：${name}`);
      if (s.status === 'running') {
        s.status = 'error'; s.error = '服务重启中断了上一轮。可以发送新消息继续。';
        // Repair outstanding calls so a resumed stateless request stays valid.
        const completed = new Set(s.history.filter(x => x.type === 'function_call_output').map(x => x.call_id));
        for (const call of s.history.filter(x => x.type === 'function_call'))
          if (!completed.has(call.call_id)) s.history.push({ type: 'function_call_output', call_id: call.call_id, output: 'Interrupted by server restart; result unknown. Inspect files before retrying.' });
        for (const m of s.messages) if (m.state === 'running') { m.state = 'error'; m.text = '服务重启，执行结果未知。'; }
        s.previousResponseId = undefined; s.responseCursor = undefined;
        this.save(s);
      }
      this.sessions.set(s.id, s);
    }
    const state = path.join(dir, 'state.json');
    if (fs.existsSync(state)) this.activeSessionId = JSON.parse(fs.readFileSync(state, 'utf8')).activeSessionId;
    if (!this.sessions.has(this.activeSessionId || '')) this.activeSessionId = null;
  }
  get(id?: string | null) {
    const s = this.sessions.get(id || this.activeSessionId || '');
    if (!s) throw new AppError('请先创建或选择会话。', 404);
    return s;
  }
  create(workspace: string, title = '新会话') {
    const root = fs.realpathSync(workspace);
    if (!fs.statSync(root).isDirectory()) throw new AppError('工作目录必须是文件夹。');
    const s: Session = { id: randomUUID(), title, workspace: root,
      createdAt: now(), updatedAt: now(), status: 'idle', messages: [], history: [],
      usage: { input: 0, output: 0, cached: 0 } };
    this.sessions.set(s.id, s); this.save(s); this.select(s.id); return s;
  }
  select(id: string) {
    const s = this.get(id); this.activeSessionId = id;
    atomicWrite(path.join(this.dir, 'state.json'), JSON.stringify({ activeSessionId: id }));
    this.emit('change', { sessionId: id }); return s;
  }
  save(s: Session) {
    s.updatedAt = now();
    atomicWrite(path.join(this.dir, 'sessions', `${s.id}.json`), JSON.stringify(s, null, 2));
    this.emit('change', { sessionId: s.id });
  }
  add(s: Session, message: Omit<Message, 'id' | 'time'>) {
    const m = { ...message, id: randomUUID(), time: now() }; s.messages.push(m); this.save(s); return m;
  }
  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ id, title, workspace, createdAt, updatedAt, status, usage }) =>
        ({ id, title, workspace, createdAt, updatedAt, status, usage }));
  }
  view(s: Session) {
    const { history, providerKey, responseCursor, ...visible } = s;
    return { ...visible, historyItems: history.length,
      pendingGuidance: s.messages.filter(m => m.kind === 'guidance' && m.delivery === 'queued').length };
  }
}
