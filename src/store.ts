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
export type CodexSandbox = 'danger-full-access' | 'workspace-write' | 'read-only';
export type ExecutionDefaults = { backend: 'deepseek' | 'codex'; profileId?: string; model?: string; codexSandbox?: CodexSandbox };
export type CodexBinding = { profileId: string; model: string; sandbox?: CodexSandbox; threadId?: string; syncedItemIds?: string[] };
export type ModelRequestMetric = {
  schemaVersion: 1; backend: 'deepseek' | 'codex'; scope: 'api_request' | 'codex_turn';
  startedAt: string; completedAt: string; durationMs: number;
  model: string; providerId?: string; apiFormat?: 'responses' | 'chat_completions';
  requestedServiceTier?: string; actualServiceTier?: string; status: 'success' | 'error';
  responseStatus?: string; errorStatus?: number; inputTokens?: number; outputTokens?: number;
  cachedTokens?: number; reasoningTokens?: number; estimatedCostUsd?: number; timeToFirstTextMs?: number;
};
export type AgentRunMetric = {
  schemaVersion: 1; scope: 'agent_run'; startedAt: string; completedAt: string; durationMs: number;
  backend: 'deepseek' | 'codex'; providerId?: string; model: string;
  status: 'idle' | 'error' | 'cancelled';
};
export type AdaptiveWait = { waitMs: number; elapsedMs: number; p80Ms?: number; sampleSize: number; source: 'history_p80' | 'fallback' | 'not_running' | 'explicit' };
export type Session = {
  id: string; title: string; workspace: string; createdAt: string; updatedAt: string;
  status: 'idle' | 'running' | 'error' | 'cancelled';
  messages: Message[]; history: ApiItem[]; previousResponseId?: string;
  responseCursor?: number; providerKey?: string; error?: string;
  contextBudget?: ContextBudget;
  backend?: 'deepseek' | 'codex'; providerId?: string; model?: string; codex?: CodexBinding;
  usage: { input: number; output: number; cached: number; lastServiceTier?: string; estimatedCosts?: Record<string, EstimatedCost>;
    providerEstimate?: { usd: number; input: number; output: number; cached: number; calls: number } };
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
  private runStartedAt = new Map<string, number>();
  activeSessionId: string | null = null;
  holidayOverrideDate: string | null = null;
  executionDefaults: ExecutionDefaults = { backend: 'deepseek', codexSandbox: 'danger-full-access' };
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
        this.executionDefaults = { ...this.executionDefaults, ...saved.executionDefaults };
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
      s.codex = { profileId: execution.profileId, model: execution.model, sandbox: execution.codexSandbox || 'danger-full-access' };
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
  setExecutionDefaults(value: ExecutionDefaults) {
    this.executionDefaults = { ...this.executionDefaults, ...value,
      ...(value.backend === 'codex' ? { codexSandbox: value.codexSandbox || this.executionDefaults.codexSandbox || 'danger-full-access' } : {}) };
    this.saveState(); this.emit('change', {});
  }
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
  recordModelRequest(s: Session, metric: ModelRequestMetric) {
    try {
      const dir = path.join(this.dir, 'metrics');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${s.id}.jsonl`), `${JSON.stringify(metric)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Telemetry must not turn a successful or billable model call into an agent failure.
      console.error('无法保存模型耗时记录。');
    }
  }
  beginAgentRun(s: Session) { this.runStartedAt.set(s.id, Date.now()); }
  recordAgentRun(s: Session, metric: AgentRunMetric) {
    this.runStartedAt.delete(s.id);
    try {
      const dir = path.join(this.dir, 'metrics');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'agent-runs.jsonl'), `${JSON.stringify(metric)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      console.error('无法保存 Agent 运行耗时记录。');
    }
  }
  adaptiveWait(s: Session): AdaptiveWait {
    const startedAt = this.runStartedAt.get(s.id);
    if (s.status !== 'running' || startedAt === undefined)
      return { waitMs: 0, elapsedMs: 0, sampleSize: 0, source: 'not_running' };
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const maxWaitMs = 55_000;
    try {
      const file = path.join(this.dir, 'metrics', 'agent-runs.jsonl');
      if (!fs.existsSync(file)) return { waitMs: maxWaitMs, elapsedMs, sampleSize: 0, source: 'fallback' };
      const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-500);
      const history: AgentRunMetric[] = [];
      for (const row of rows) {
        try {
          const value = JSON.parse(row);
          if (value.schemaVersion === 1 && value.scope === 'agent_run' &&
              (value.backend === 'deepseek' || value.backend === 'codex') &&
              typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 1000 &&
              (value.status === 'idle' || value.status === 'error') && typeof value.model === 'string') history.push(value);
        } catch { /* Ignore malformed historical rows. */ }
      }
      const backend = s.backend || 'deepseek', model = s.codex?.model || s.model || '';
      const forBackend = history.filter(item => item.backend === backend);
      const exact = forBackend.filter(item => item.model === model && item.providerId === (s.backend === 'codex' ? s.codex?.profileId : s.providerId));
      const sample = exact.length >= 5 ? exact.slice(-100) : forBackend.slice(-100);
      if (sample.length < 5) return { waitMs: maxWaitMs, elapsedMs, sampleSize: sample.length, source: 'fallback' };
      const sorted = sample.map(item => item.durationMs).sort((a, b) => a - b);
      const p80Ms = sorted[Math.ceil(sorted.length * 0.8) - 1];
      const waitMs = elapsedMs >= p80Ms ? maxWaitMs : Math.max(1000, Math.min(maxWaitMs, Math.round(p80Ms - elapsedMs)));
      return { waitMs, elapsedMs, p80Ms, sampleSize: sample.length, source: 'history_p80' };
    } catch {
      return { waitMs: maxWaitMs, elapsedMs, sampleSize: 0, source: 'fallback' };
    }
  }
  add(s: Session, message: Omit<Message, 'id' | 'time'>) {
    const m = { ...message, id: randomUUID(), time: now() }; s.messages.push(m); this.save(s); return m;
  }
  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ id, title, workspace, createdAt, updatedAt, status, usage, contextBudget, backend, providerId, model, codex }) =>
        ({ id, title, workspace, createdAt, updatedAt, status, usage, contextBudget, backend: backend || 'deepseek', providerId, model,
          ...(codex ? { codex: { profileId: codex.profileId, model: codex.model, sandbox: codex.sandbox, threadId: codex.threadId } } : {}) }));
  }
  view(s: Session) {
    const { history, providerKey, responseCursor, codex, ...visible } = s;
    return { ...visible, historyItems: history.length,
      backend: s.backend || 'deepseek',
      ...(codex ? { codex: { profileId: codex.profileId, model: codex.model, sandbox: codex.sandbox, threadId: codex.threadId } } : {}),
      pendingGuidance: s.messages.filter(m => m.kind === 'guidance' && m.delivery === 'queued').length };
  }
}
