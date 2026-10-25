import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { AppError, atomicWrite, type ExecutionDefaults, Store } from './store.js';
import { CodexRpc, codexLaunch } from './codex-rpc.js';

export type CodexModel = { id: string; model: string; displayName: string; isDefault?: boolean;
  defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort: string }[] };
type Profile = { id: string; home: string; label: string };
type ProfileState = { loggedIn: boolean; email?: string; plan?: string; error?: string;
  rateLimits?: any; models: CodexModel[]; login?: any; checkedAt?: number };

export class CodexAccounts {
  private profiles: Profile[];
  private states = new Map<string, ProfileState>();
  private clients = new Map<string, CodexRpc>();
  private refreshing = new Map<string, Promise<ProfileState>>();
  private file: string;
  constructor(readonly config: Config, private store: Store) {
    this.file = path.join(config.dataDir, 'codex-profiles.json');
    this.profiles = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
    if (!this.profiles.length) {
      this.profiles.push({ id: 'default', home: config.codexHome, label: 'Codex 1' }); this.save();
    }
    for (const profile of this.profiles) {
      // Credentials must never share the desktop app's own auth directory.
      if (path.resolve(profile.home).toLowerCase() === path.resolve(config.codexSqliteHome).toLowerCase())
        throw new Error('Codex 登录目录必须独立于共享会话索引目录，请修改 LABOR_CODEX_HOME。');
      fs.mkdirSync(profile.home, { recursive: true });
      const configFile = path.join(profile.home, 'config.toml');
      if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
      this.states.set(profile.id, { loggedIn: false, models: [] });
    }
  }
  private save() { atomicWrite(this.file, JSON.stringify(this.profiles, null, 2)); }
  private changed() { this.store.emit('change', {}); }
  private profile(id: string) {
    const profile = this.profiles.find(p => p.id === id);
    if (!profile) throw new AppError('Codex 账号配置不存在。', 404);
    return profile;
  }
  snapshot() {
    let error: string | undefined;
    try { codexLaunch(this.config.codexCommand); } catch (e) { error = (e as Error).message; }
    return { available: !error, error, profiles: this.profiles.map(profile => {
      const state = this.states.get(profile.id)!;
      return { id: profile.id, label: profile.label, ...state };
    }) };
  }
  loggedIn(id?: string) { return !!id && !!this.states.get(id)?.loggedIn; }
  async client(id: string) {
    const profile = this.profile(id);
    const existing = this.clients.get(id); if (existing) { await existing.start(); return existing; }
    const client = new CodexRpc(this.config, profile.home); this.clients.set(id, client);
    client.on('notification', (method: string, params: any) => {
      if (method === 'account/login/completed') {
        const state = this.states.get(id)!; state.login = undefined;
        if (params.success) void this.refresh(id, true).catch(() => {});
        else { state.error = params.error || '登录未完成。'; this.changed(); }
      }
      if (method === 'account/rateLimits/updated') {
        this.states.get(id)!.rateLimits = params.rateLimits; this.changed();
      }
    });
    client.on('disconnected', () => { if (this.clients.get(id) === client) this.clients.delete(id); });
    try { await client.start(); return client; }
    catch (error) { if (this.clients.get(id) === client) this.clients.delete(id); client.close(); throw error; }
  }
  async refresh(id: string, force = false): Promise<ProfileState> {
    this.profile(id);
    const cached = this.states.get(id)!;
    if (!force && cached.checkedAt && Date.now() - cached.checkedAt < 60000) return cached;
    if (this.refreshing.has(id)) return this.refreshing.get(id)!;
    const promise = (async () => {
      try {
        const client = await this.client(id);
        const account = (await client.request('account/read', { refreshToken: false })).account;
        cached.loggedIn = account?.type === 'chatgpt'; cached.email = account?.email || undefined;
        cached.plan = account?.planType; cached.error = undefined; cached.models = [];
        if (cached.loggedIn) {
          const modelsPromise = (async () => {
            const models: CodexModel[] = []; let cursor: string | undefined;
            for (let page = 0; page < 10; page++) {
              const result = await client.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
              models.push(...result.data.filter((m: any) => !m.hidden).map((m: any) => ({ id: m.id, model: m.model || m.id,
                displayName: m.displayName || m.model || m.id, isDefault: m.isDefault,
                defaultReasoningEffort: m.defaultReasoningEffort, supportedReasoningEfforts: m.supportedReasoningEfforts })));
              cursor = result.nextCursor; if (!cursor) break;
            }
            cached.models = models;
          })();
          const limitsPromise = client.request('account/rateLimits/read').then(r => { cached.rateLimits = r.rateLimits; }).catch(() => {});
          await Promise.all([modelsPromise, limitsPromise]);
        } else cached.rateLimits = undefined;
      } catch (error) { cached.error = (error as Error).message.slice(0, 500); }
      cached.checkedAt = Date.now(); this.changed(); return cached;
    })().finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, promise); return promise;
  }
  async describe(id: string, force = false) {
    const state = await this.refresh(id, force);
    return { ...this.snapshot(), profileId: id, models: state.models };
  }
  async login(id = 'default', add = false) {
    if (add) {
      id = randomUUID();
      const home = path.join(this.config.dataDir, 'codex-accounts', id); fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
      this.profiles.push({ id, home, label: `Codex ${this.profiles.length + 1}` });
      this.states.set(id, { loggedIn: false, models: [] }); this.save();
    }
    const state = this.states.get(this.profile(id).id)!;
    if (state.login) return { profileId: id, ...state.login };
    if ((await this.refresh(id, true)).loggedIn) return { profileId: id, alreadyLoggedIn: true };
    const client = await this.client(id);
    let result;
    try { result = await client.request('account/login/start', { type: 'chatgptDeviceCode' }); }
    catch { result = await client.request('account/login/start', { type: 'chatgpt' }); }
    // Only the official authorization link/code is sent to the browser.
    const href = result.verificationUrl || result.authUrl;
    const url = new URL(href);
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname))
      throw new AppError('Codex 返回了无法识别的登录地址。');
    state.login = { type: result.type, verificationUrl: result.verificationUrl, userCode: result.userCode, authUrl: result.authUrl };
    state.error = undefined; this.changed(); return { profileId: id, ...state.login };
  }
  async logout(id: string) {
    if ([...this.store.sessions.values()].some(s => s.codex?.profileId === id && s.status === 'running'))
      throw new AppError('此账号有任务运行，请先结束或停止后再退出登录。', 409);
    const client = await this.client(id); await client.request('account/logout');
    Object.assign(this.states.get(id)!, { loggedIn: false, models: [], email: undefined, plan: undefined, rateLimits: undefined, login: undefined, error: undefined, checkedAt: Date.now() });
    this.changed();
  }
  async binding(value: ExecutionDefaults): Promise<ExecutionDefaults> {
    if (value.backend === 'deepseek') return { backend: 'deepseek' };
    const id = value.profileId || this.store.executionDefaults.profileId || this.profiles[0].id;
    const state = await this.refresh(id);
    if (!state.loggedIn) throw new AppError(state.error || '请先在左下角登录 Codex 账号。');
    const model = value.model ? state.models.find(m => m.model === value.model || m.id === value.model)
      : state.models.find(m => m.isDefault) || state.models[0];
    if (!model) throw new AppError('Codex 模型未找到，请刷新模型列表后重新选择。');
    return { backend: 'codex', profileId: id, model: model.model };
  }
  async model(id: string, name: string) {
    const state = await this.refresh(id);
    if (!state.loggedIn) throw new AppError('此 session 绑定的 Codex 账号尚未登录。');
    const model = state.models.find(m => m.model === name || m.id === name);
    if (!model) throw new AppError('该模型不在当前 Codex 模型目录中，请重新选择。');
    return model;
  }
  close() { for (const client of this.clients.values()) client.close(); this.clients.clear(); }
}
