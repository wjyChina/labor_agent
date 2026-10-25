import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { EstimatedCost } from './pricing.js';

export type ApiItem = Record<string, any>;
export type Message = {
  id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string;
  time: string; source?: 'mcp' | 'web'; tool?: string; args?: unknown;
  state?: 'running' | 'done' | 'error' | 'skipped';
  kind?: 'guidance'; delivery?: 'queued' | 'applied';
  nativeId?: string;
};
export type ContextBudget = {
  limitTokens: number; warnRatio: number; estimatedInputTokens: number;
  reservedOutputTokens: number; estimatedRequestTokens: number; ratio: number;
  status: 'ok' | 'warning' | 'exceeded'; source: 'estimate' | 'provider'; updatedAt: string;
};
export type ExecutionDefaults = { backend: 'deepseek' | 'codex'; profileId?: string; model?: string };
export type CodexBinding = { profileId: string; model: string; threadId?: string; syncedItemIds?: string[] };
export type Session = {
  id: string; title: string; workspace: string; createdAt: string; updatedAt: string;
  status: 'idle' | 'running' | 'error' | 'cancelled';
  messages: Message[]; history: ApiItem[]; previousResponseId?: string;
  responseCursor?: number; providerKey?: string; error?: string;
  contextBudget?: ContextBudget;
  backend?: 'deepseek' | 'codex'; providerId?: string; model?: string; codex?: CodexBinding;
  usage: { input: number; output: number; cached: number; estimatedCosts?: Record<string, EstimatedCost> };
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
  holidayOverrideDate: string | null = null;
  executionDefaults: ExecutionDefaults = { backend: 'deepseek' };
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
    if (fs.existsSync(state)) {
      const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
      this.activeSessionId = saved.activeSessionId;
      if (saved.executionDefaults?.backend === 'deepseek' || saved.executionDefaults?.backend === 'codex')
        this.executionDefaults = saved.executionDefaults;
      if (typeof saved.holidayOverrideDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(saved.holidayOverrideDate))
        this.holidayOverrideDate = saved.holidayOverrideDate;
    }
    if (!this.sessions.has(this.activeSessionId || '')) this.activeSessionId = null;
  }
  get(id?: string | null) {
    const s = this.sessions.get(id || this.activeSessionId || '');
    if (!s) throw new AppError('请先创建或选择会话。', 404);
    return s;
  }
  create(workspace: string, title = '新会话', execution?: ExecutionDefaults) {
    const root = fs.realpathSync(workspace);
    if (!fs.statSync(root).isDirectory()) throw new AppError('工作目录必须是文件夹。');
    const s: Session = { id: randomUUID(), title, workspace: root,
      createdAt: now(), updatedAt: now(), status: 'idle', messages: [], history: [],
      usage: { input: 0, output: 0, cached: 0 } };
    s.backend = execution?.backend || 'deepseek';
    if (s.backend === 'codex') {
      if (!execution?.profileId || !execution.model) throw new AppError('请先选择 Codex 账号和模型。');
      s.codex = { profileId: execution.profileId, model: execution.model };
    } else { s.providerId = execution?.profileId; s.model = execution?.model; }
    this.sessions.set(s.id, s); this.save(s); this.select(s.id); return s;
  }
  select(id: string) {
    const s = this.get(id); this.activeSessionId = id;
    this.saveState();
    this.emit('change', { sessionId: id }); return s;
  }
  setHolidayOverride(date: string, enabled: boolean) {
    if (enabled) this.holidayOverrideDate = date;
    else if (this.holidayOverrideDate === date) this.holidayOverrideDate = null;
    this.saveState();
  }
  isHolidayOverride(date: string) { return this.holidayOverrideDate === date; }
  setExecutionDefaults(value: ExecutionDefaults) { this.executionDefaults = value; this.saveState(); this.emit('change', {}); }
  private saveState() {
    atomicWrite(path.join(this.dir, 'state.json'), JSON.stringify({
      activeSessionId: this.activeSessionId, holidayOverrideDate: this.holidayOverrideDate,
      executionDefaults: this.executionDefaults,
    }));
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
      .map(({ id, title, workspace, createdAt, updatedAt, status, usage, contextBudget, backend, providerId, model, codex }) =>
        ({ id, title, workspace, createdAt, updatedAt, status, usage, contextBudget, backend: backend || 'deepseek', providerId, model,
          ...(codex ? { codex: { profileId: codex.profileId, model: codex.model, threadId: codex.threadId } } : {}) }));
  }
  view(s: Session) {
    const { history, providerKey, responseCursor, codex, ...visible } = s;
    return { ...visible, historyItems: history.length,
      backend: s.backend || 'deepseek',
      ...(codex ? { codex: { profileId: codex.profileId, model: codex.model, threadId: codex.threadId } } : {}),
      pendingGuidance: s.messages.filter(m => m.kind === 'guidance' && m.delivery === 'queued').length };
  }
}
