import { randomUUID } from 'node:crypto';
import { CodexAccounts } from './codex-accounts.js';
import type { CodexRpc } from './codex-rpc.js';
import { AppError, now, Store, type CodexSandbox, type Message, type Session } from './store.js';

type Run = { promise: Promise<void>; cancelled: boolean; client?: CodexRpc; turnId?: string;
  finish?: (turn: any) => void; pendingUserId?: string; steering?: Promise<void>; question?: string };

export class CodexAgent {
  private runs = new Map<string, Run>();
  private lastSync = new Map<string, number>();
  private syncing = new Map<string, Promise<void>>();
  constructor(readonly accounts: CodexAccounts, private store: Store) {}
  private sandboxPolicy(s: Session) {
    const mode: CodexSandbox = s.codex?.sandbox || 'danger-full-access';
    if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
    if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
    return { type: 'workspaceWrite', writableRoots: [s.workspace], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
  private validate(text: string) { if (!text.trim() || text.length > 100000) throw new AppError('消息长度必须在 1–100000 字符之间。'); }
  private queued(s: Session) { return s.messages.filter(m => m.kind === 'guidance' && m.delivery === 'queued'); }
  start(s: Session, text: string, source: 'mcp' | 'web') {
    this.validate(text);
    if (!s.codex) throw new AppError('此会话没有 Codex 账号和模型绑定。');
    if (this.runs.has(s.id)) throw new AppError('当前会话正在执行。', 409);
    const user = this.store.add(s, { role: 'user', text: text.trim(), source });
    if (s.title === '新会话') s.title = text.trim().slice(0, 32);
    s.status = 'running'; s.error = undefined; this.store.save(s);
    const run: Run = { cancelled: false, promise: Promise.resolve() };
    run.promise = Promise.resolve().then(() => this.run(s, user, run)).finally(() => { this.runs.delete(s.id); this.store.emit('change', { sessionId: s.id }); });
    this.runs.set(s.id, run); return run.promise;
  }
  guide(s: Session, text: string, source: 'mcp' | 'web') {
    this.validate(text); const run = this.runs.get(s.id);
    if (!run || run.cancelled) throw new AppError('当前会话未在 Labor 执行，或正在停止。', 409);
    if (this.queued(s).length >= 32) throw new AppError('待应用的引导过多，请等待处理。', 409);
    const message = this.store.add(s, { role: 'user', text: text.trim(), source, kind: 'guidance', delivery: 'queued' });
    if (run.turnId) void this.steer(s, run);
    return message;
  }
  private async steer(s: Session, run: Run) {
    if (run.steering) return run.steering;
    run.steering = (async () => {
      const queued = this.queued(s);
      if (!queued.length || !run.turnId || !run.client || run.cancelled) return;
      try {
        run.pendingUserId = queued[0].id;
        await run.client.request('turn/steer', { threadId: s.codex!.threadId, expectedTurnId: run.turnId,
          clientUserMessageId: queued[0].id, input: queued.map(m => ({ type: 'text', text: m.text, text_elements: [] })) });
        queued.forEach(m => { m.delivery = 'applied'; }); this.store.save(s);
      } catch {
        // A completed turn can race a steer. Keep guidance queued and start it
        // as the next turn rather than claiming that the model received it.
      }
    })().finally(() => { run.steering = undefined; });
    return run.steering;
  }
  cancel(s: Session) {
    const run = this.runs.get(s.id); if (!run) return; run.cancelled = true;
    if (run.client && run.turnId) void run.client.request('turn/interrupt', { threadId: s.codex!.threadId, turnId: run.turnId }).catch(() => {});
  }
  async wait(s: Session, ms: number) {
    const run = this.runs.get(s.id); if (!run || ms <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([run.promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
    finally { clearTimeout(timer); }
  }
  private item(s: Session, item: any, completed: boolean, at?: number, run?: Run) {
    let role: Message['role'], text = '', tool: string | undefined, args: unknown;
    if (item.type === 'userMessage') { role = 'user'; text = (item.content || []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n'); }
    else if (item.type === 'agentMessage') { role = 'assistant'; text = item.text || ''; }
    else if (item.type === 'commandExecution') { role = 'tool'; tool = 'codex_command'; args = { command: item.command, cwd: item.cwd };
      text = JSON.stringify({ exit_code: item.exitCode, output: item.aggregatedOutput || '', status: item.status }); }
    else if (item.type === 'fileChange') { role = 'tool'; tool = 'codex_change'; args = { paths: (item.changes || []).map((c: any) => c.path) }; text = JSON.stringify(item.changes || []); }
    else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') { role = 'tool'; tool = item.tool || item.type; args = item.arguments; text = JSON.stringify(item.result || item.error || item.contentItems || ''); }
    else return false;
    let message = s.messages.find(m => m.nativeId === item.id);
    if (!message && role === 'user') message = s.messages.find(m => m.id === (item.clientId || run?.pendingUserId));
    const state: Message['state'] = ['failed', 'declined'].includes(item.status) ? 'error' : completed ? 'done' : 'running';
    if (!message) {
      message = { id: randomUUID(), nativeId: item.id, role, text, time: at ? new Date(at).toISOString() : now(), tool, args, state };
      s.messages.push(message); return true;
    }
    // Keep individual coordinator guidance messages instead of replacing their
    // text with Codex's combined user-input item.
    const nextText = role === 'user' && message.source ? message.text : text;
    const changed = message.nativeId !== item.id || message.text !== nextText || message.state !== state || JSON.stringify(message.args) !== JSON.stringify(args);
    Object.assign(message, { nativeId: item.id, text: nextText, tool, args, state });
    if (role === 'user' && run) run.pendingUserId = undefined;
    return changed;
  }
  private usage(s: Session, value: any) {
    const total = value.total || {}, last = value.last || {}, window = value.modelContextWindow;
    s.usage.input = total.inputTokens || 0; s.usage.cached = total.cachedInputTokens || 0; s.usage.output = total.outputTokens || 0;
    if (window > 0) {
      const input = last.inputTokens || 0, ratio = input / window;
      s.contextBudget = { limitTokens: window, warnRatio: 0.9, estimatedInputTokens: input, reservedOutputTokens: 0,
        estimatedRequestTokens: input, ratio, status: ratio >= 1 ? 'exceeded' : ratio >= 0.9 ? 'warning' : 'ok', source: 'provider', updatedAt: now() };
    }
  }
  private async run(s: Session, user: Message, run: Run) {
    let notify: ((method: string, params: any) => void) | undefined;
    let disconnected: ((e: Error) => void) | undefined;
    let serverRequest: ((message: any) => void) | undefined;
    try {
      const model = await this.accounts.model(s.codex!.profileId, s.codex!.model);
      const client = run.client = await this.accounts.client(s.codex!.profileId);
      if (run.cancelled) throw new Error('已停止');
      if (!s.codex!.threadId) {
        const result = await client.request('thread/start', { cwd: s.workspace, model: model.model,
          sandbox: 'workspace-write', approvalPolicy: 'never', ephemeral: false, serviceName: 'labor_agent',
          developerInstructions: 'Follow the task scope and acceptance criteria. Read applicable AGENTS.md. Keep reports concise with artifact paths and actual verification evidence. Do not repeat large logs or tables.' });
        s.codex!.threadId = result.thread.id; this.store.save(s);
        await client.request('thread/name/set', { threadId: result.thread.id, name: s.title });
      } else {
        const resumed = await client.request('thread/resume', { threadId: s.codex!.threadId, excludeTurns: true, model: model.model });
        if (resumed.thread.status?.type === 'active') throw new AppError('此原生会话正在其他 Codex 入口执行，请结束当前轮后再接管。', 409);
        await this.sync(s, true);
      }
      notify = (method, params) => {
        if (params.threadId !== s.codex!.threadId) return;
        if (method === 'item/started' || method === 'item/completed') {
          if (this.item(s, params.item, method === 'item/completed', params.startedAtMs || params.completedAtMs, run)) this.store.save(s);
        } else if (method === 'item/agentMessage/delta') {
          let message = s.messages.find(m => m.nativeId === params.itemId);
          if (!message) { message = { id: randomUUID(), nativeId: params.itemId, role: 'assistant', text: '', time: now(), state: 'running' }; s.messages.push(message); }
          message.text += params.delta || ''; this.store.emit('change', { sessionId: s.id });
        } else if (method === 'thread/tokenUsage/updated') { this.usage(s, params.tokenUsage); this.store.save(s); }
        else if (method === 'error' && !params.willRetry) { s.error = params.error?.message || params.message || 'Codex 执行错误。'; }
        else if (method === 'turn/completed') run.finish?.(params.turn);
      };
      disconnected = error => run.finish?.({ status: 'failed', error: { message: error.message } });
      serverRequest = message => {
        if (message.params?.threadId !== s.codex!.threadId) return;
        run.question = message.method.includes('requestUserInput')
          ? `Codex 需要补充信息：${JSON.stringify(message.params.questions || message.params).slice(0, 3000)}`
          : 'Codex 请求交互授权，当前轮已暂停。请确认所需操作后补充要求，或在 Codex 客户端接管。';
        if (run.turnId) void client.request('turn/interrupt', { threadId: s.codex!.threadId, turnId: run.turnId }).catch(() => {});
      };
      client.on('notification', notify); client.on('disconnected', disconnected); client.on('serverRequest', serverRequest);
      let initial = true;
      while (initial || this.queued(s).length) {
        if (run.cancelled) throw new Error('已停止');
        const queued = this.queued(s);
        const input = [...queued, ...(initial ? [user] : [])];
        run.pendingUserId = input[0].id;
        const terminal = new Promise<any>(resolve => { run.finish = resolve; });
        const started = await client.request('turn/start', { threadId: s.codex!.threadId, model: model.model,
          cwd: s.workspace, approvalPolicy: 'never', sandboxPolicy: this.sandboxPolicy(s),
          ...(model.defaultReasoningEffort ? { effort: model.defaultReasoningEffort } : {}),
          clientUserMessageId: input[0].id, input: input.map(m => ({ type: 'text', text: m.text, text_elements: [] })) });
        initial = false; queued.forEach(m => { m.delivery = 'applied'; }); run.turnId = started.turn.id; this.store.save(s);
        if (run.cancelled || run.question) void client.request('turn/interrupt', { threadId: s.codex!.threadId, turnId: run.turnId }).catch(() => {});
        else if (this.queued(s).length) void this.steer(s, run);
        const turn = await terminal; run.turnId = undefined;
        if (run.steering) await run.steering;
        if (run.cancelled || turn.status === 'interrupted') throw new Error(run.question || '本轮已停止。已完成的修改会保留。');
        if (run.question) throw new Error(run.question);
        if (turn.status !== 'completed') throw new Error(turn.error?.message || s.error || 'Codex 本轮执行失败。');
      }
      s.status = 'idle'; s.error = undefined;
    } catch (error) {
      s.status = run.cancelled ? 'cancelled' : 'error'; s.error = run.question || (error as Error).message;
      this.store.add(s, { role: 'system', text: s.error });
    } finally {
      if (notify) run.client?.off('notification', notify);
      if (disconnected) run.client?.off('disconnected', disconnected);
      if (serverRequest) run.client?.off('serverRequest', serverRequest);
      for (const message of s.messages) if (message.state === 'running') message.state = s.status === 'idle' ? 'done' : 'error';
      this.store.save(s);
    }
  }
  async sync(s: Session, force = false): Promise<void> {
    if (!s.codex?.threadId || (!force && this.runs.has(s.id))) return;
    if (!force && Date.now() - (this.lastSync.get(s.id) || 0) < 5000) return;
    if (this.syncing.has(s.id)) return this.syncing.get(s.id)!;
    const promise = (async () => {
      const client = await this.accounts.client(s.codex!.profileId);
      const metadata = await client.request('thread/read', { threadId: s.codex!.threadId, includeTurns: false });
      let changed = false;
      if (metadata.thread.name && metadata.thread.name !== s.title) { s.title = metadata.thread.name; changed = true; }
      const known = new Set(s.messages.map(m => m.nativeId).filter(Boolean));
      let cursor: string | undefined; const pages: any[][] = []; const seen = new Set<string>();
      do {
        const result = await client.request('thread/items/list', { threadId: s.codex!.threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) });
        pages.push(result.data || []);
        const found = result.data.some((entry: any) => known.has(entry.item.id));
        cursor = found ? undefined : result.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Codex 返回了重复的历史分页游标。');
        if (cursor) seen.add(cursor);
      } while (cursor);
      for (const page of pages.reverse()) for (const entry of [...page].reverse())
        changed = this.item(s, entry.item, !!entry.completedAtMs || entry.item.type === 'userMessage', entry.startedAtMs || entry.completedAtMs) || changed;
      this.lastSync.set(s.id, Date.now()); if (changed) this.store.save(s);
    })().finally(() => this.syncing.delete(s.id));
    this.syncing.set(s.id, promise); return promise;
  }
  async rename(s: Session) {
    if (s.codex?.threadId) await (await this.accounts.client(s.codex.profileId)).request('thread/name/set', { threadId: s.codex.threadId, name: s.title });
  }
  async shutdown() {
    for (const id of this.runs.keys()) this.cancel(this.store.get(id));
    const pending = Promise.allSettled([...this.runs.values()].map(r => r.promise));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); clearTimeout(timer);
    this.accounts.close(); await pending;
  }
}
