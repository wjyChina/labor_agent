import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { Store, AppError } from './store.js';
import { Agent } from './agent.js';
import { CodexAccounts } from './codex-accounts.js';
import { CodexAgent } from './codex-agent.js';
import { ProviderProfiles } from './provider-profiles.js';
import { HolidayCalendar } from './holiday-calendar.js';
import { ExchangeRateCache } from './exchange-rate.js';
import { beijingDate } from './pricing.js';
import { baseUrl, serviceId, mcpToken } from './service.js';
import { MAX_AGENT_WAIT_MS } from './wait-policy.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const lockPath = path.join(config.dataDir, 'server.lock');
const lockId = randomUUID();
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, lockId, port: config.port })); fs.closeSync(fd); return;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      let previous;
      try { previous = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
      catch { throw new Error(`无法读取服务锁 ${lockPath}，请检查是否有服务正在启动。`); }
      try { process.kill(previous.pid, 0); }
      catch (error: any) {
        if (error.code !== 'ESRCH') throw error;
        fs.unlinkSync(lockPath); continue;
      }
      throw new Error(`数据目录已有服务运行（PID ${previous.pid}，端口 ${previous.port}）。`);
    }
  }
  throw new Error('无法取得服务锁。');
}
acquireLock();
function releaseLock() {
  try { if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).lockId === lockId) fs.unlinkSync(lockPath); } catch {}
}
process.once('exit', releaseLock);
const store = new Store(config.dataDir);
const holidayCalendar = new HolidayCalendar(config.dataDir, () =>
  store.emit('change', { sessionId: store.activeSessionId || undefined }));
const exchangeRate = new ExchangeRateCache(config.dataDir, () =>
  store.emit('change', { sessionId: store.activeSessionId || undefined }));
const agent = new Agent(config, store, holidayCalendar);
const codexAccounts = new CodexAccounts(config, store);
const codexAgent = new CodexAgent(codexAccounts, store);
const providerProfiles = new ProviderProfiles(config, store);
const deepSeekAgents = new Map<string, { agent: Agent; fingerprint: string }>();
function deepSeekAgent(session: ReturnType<Store['get']>) {
  // Sessions created before provider profiles were introduced keep using the
  // original .env configuration; new sessions carry an explicit profile ID.
  const profile = session.providerId ? providerProfiles.profile(session.providerId) : undefined;
  const runtimeConfig = profile ? providerProfiles.configFor(profile.id) : config;
  const fingerprint = profile ? JSON.stringify([profile.id, profile.baseUrl, profile.model, profile.apiKey, profile.cacheMode, profile.reasoningEffort, profile.apiFormat, profile.serviceTier]) : 'legacy-env';
  const existing = deepSeekAgents.get(session.id);
  if (existing && session.status === 'running') return existing.agent;
  if (!existing || existing.fingerprint !== fingerprint) {
    const next = { agent: new Agent(runtimeConfig, store, holidayCalendar), fingerprint };
    deepSeekAgents.set(session.id, next); return next.agent;
  }
  return existing.agent;
}
function runnerFor(session: ReturnType<Store['get']>) { return session.backend === 'codex' ? codexAgent : deepSeekAgent(session); }
function sessionProvider(session: ReturnType<Store['get']>) {
  if (session.backend === 'codex') return { backend: 'codex', label: 'Codex', model: session.codex?.model || '默认模型' };
  if (session.providerId) {
    try { const profile = providerProfiles.profile(session.providerId); return { backend: 'deepseek', label: profile.label, model: session.model || profile.model }; }
    catch {}
  }
  return { backend: 'deepseek', label: 'DeepSeek（旧配置）', model: config.model };
}
const sessionCreationToken = mcpToken(config);
const app = express(); app.disable('x-powered-by');
const origin = baseUrl(config), localOrigin = `http://localhost:${config.port}`;
function openLocalUi(url: string) {
  let command: string, args: string[];
  if (process.platform === 'win32') {
    command = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/s', '/c', `start "" "${url}"`];
  } else if (process.platform === 'darwin') {
    command = 'open'; args = [url];
  } else {
    command = 'xdg-open'; args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', error => console.error(`无法自动打开 Labor Agent 网页：${error.message}`));
  child.unref();
}
app.use((req, res, next) => {
  if (![new URL(origin).host, new URL(localOrigin).host].includes(req.headers.host || ''))
    return res.status(403).json({ error: '仅允许本机地址访问。' });
  if (req.headers.origin && ![origin, localOrigin].includes(req.headers.origin))
    return res.status(403).json({ error: '拒绝跨站请求。' });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json'))
    return res.status(415).json({ error: '请求必须使用 application/json。' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
function chooseFolder(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "选择 Labor Agent 项目文件夹"',
      '$dialog.ShowNewFolderButton = $false',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
    ].join('; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) reject(new Error(error.trim() || '无法打开系统文件夹选择器。'));
      else resolve(output.trim() || null);
    });
  });
}
app.post('/api/dialog/select-folder', async (_req, res) => {
  const selected = await chooseFolder();
  if (!selected) return res.json({ cancelled: true });
  const workspace = fs.realpathSync(selected);
  if (!fs.statSync(workspace).isDirectory()) throw new AppError('选择的路径不是文件夹。');
  res.json({ cancelled: false, workspace });
});
const status = () => {
  const date = beijingDate(new Date()), calendar = holidayCalendar.status(date);
  const manualOverride = store.isHolidayOverride(date);
  const execution = store.executionDefaults;
  let activeProvider: any = { backend: execution.backend, profileId: execution.profileId, model: execution.model };
  let configured = false, baseUrl = config.baseUrl, model = config.model, cacheMode = config.cacheMode;
  if (execution.backend === 'deepseek') {
    try {
      const profile = providerProfiles.profile(execution.profileId);
      activeProvider = { backend: 'deepseek', kind: profile.kind, profileId: profile.id, label: profile.label, model: profile.model, baseUrl: profile.baseUrl,
        apiFormat: profile.apiFormat, serviceTier: profile.serviceTier };
      configured = !!profile.apiKey; baseUrl = profile.baseUrl; model = profile.model; cacheMode = profile.cacheMode;
    } catch {}
  } else {
    configured = codexAccounts.loggedIn(execution.profileId); model = execution.model || 'Codex'; baseUrl = 'codex://app-server'; activeProvider = { ...activeProvider, label: 'Codex' };
  }
  return { app: 'labor-agent', version: '0.1.0', serviceId: serviceId(config), pid: process.pid,
    url: origin, configured, model, baseUrl, activeProvider,
    workspace: config.workspace, cacheMode, bashPath: agent.tools.bashPath,
    contextLimitTokens: config.contextLimitTokens, contextWarnRatio: config.contextWarnRatio,
    activeSessionId: store.activeSessionId, running: store.list().filter(s => s.status === 'running').length,
    executionDefaults: store.executionDefaults,
    holidayCalendar: { ...calendar, automaticHoliday: calendar.isHoliday, manualOverride,
      isHoliday: calendar.isHoliday || manualOverride },
    usdCnyRate: exchangeRate.get() };
};
app.get('/api/health', (_req, res) => { res.json(status()); });
app.get('/api/state', async (_req, res) => {
  const active = store.activeSessionId ? store.get() : null;
  if (active?.backend === 'codex') { try { await codexAgent.sync(active); } catch {} }
  res.json({ ...status(), sessions: store.list(),
    session: active ? store.view(active) : null, sessionProvider: active ? sessionProvider(active) : null });
});
app.get('/api/stats/tokens', (req, res) => {
  const range = z.enum(['7', '30', '90', '365', 'all']).default('30').parse(req.query.range);
  const metricsDir = path.join(config.dataDir, 'metrics');
  const providers = new Map(providerProfiles.snapshot().profiles.map(profile => [profile.id, profile]));
  const codexProfiles = new Map(codexAccounts.snapshot().profiles.map(profile => [profile.id, profile]));
  type ConfigMetric = { id: string; backend: 'deepseek' | 'codex'; providerId?: string; model: string;
    apiFormat?: string; serviceTier?: string; label: string; lastSeen: string };
  type DailyMetric = { inputTokens: number; cachedTokens: number; outputTokens: number; calls: number;
    speedOutputTokens: number; speedDurationMs: number; estimatedCostUsd: number; costCalls: number };
  const configs = new Map<string, ConfigMetric>();
  const daily = new Map<string, Map<string, DailyMetric>>();
  if (fs.existsSync(metricsDir)) {
    for (const file of fs.readdirSync(metricsDir).filter(name => name.endsWith('.jsonl') && name !== 'agent-runs.jsonl')) {
      let rows: string[];
      try { rows = fs.readFileSync(path.join(metricsDir, file), 'utf8').split(/\r?\n/).filter(Boolean); }
      catch { continue; }
      for (const row of rows) {
        try {
          const metric = JSON.parse(row);
          if (metric.schemaVersion !== 1 || !['api_request', 'codex_turn'].includes(metric.scope) ||
              !['deepseek', 'codex'].includes(metric.backend) || typeof metric.model !== 'string' ||
              typeof metric.completedAt !== 'string' || !Number.isFinite(Date.parse(metric.completedAt))) continue;
          const backend = metric.backend as 'deepseek' | 'codex';
          const providerId = typeof metric.providerId === 'string' ? metric.providerId : undefined;
          const apiFormat = typeof metric.apiFormat === 'string' ? metric.apiFormat : undefined;
          const serviceTier = typeof metric.requestedServiceTier === 'string' ? metric.requestedServiceTier : undefined;
          const configId = [backend, providerId || (backend === 'codex' ? 'unknown' : 'legacy-env'), metric.model,
            apiFormat || '', serviceTier || ''].map(value => encodeURIComponent(value)).join('|');
          const providerLabel = backend === 'codex'
            ? (codexProfiles.get(providerId || '')?.label || (providerId ? `Codex ${providerId.slice(0, 8)}` : 'Codex'))
            : (providerId ? providers.get(providerId)?.label || `已删除配置 ${providerId.slice(0, 8)}` : 'DeepSeek（旧配置）');
          const apiLabel = apiFormat === 'chat_completions' ? 'Chat Completions' : apiFormat === 'responses' ? 'Responses' : '';
          const tierLabel = serviceTier && serviceTier !== 'default' ? serviceTier.toUpperCase() : '';
          const label = [providerLabel, metric.model, tierLabel, apiLabel].filter(Boolean).join(' · ');
          const completedAt = new Date(metric.completedAt);
          const date = beijingDate(completedAt);
          const entry: ConfigMetric = { id: configId, backend, ...(providerId ? { providerId } : {}), model: metric.model,
            ...(apiFormat ? { apiFormat } : {}), ...(serviceTier ? { serviceTier } : {}), label, lastSeen: metric.completedAt };
          const previous = configs.get(configId);
          if (!previous || previous.lastSeen < entry.lastSeen) configs.set(configId, entry);
          const value = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0;
          const inputTokens = value(metric.inputTokens);
          const cachedTokens = Math.min(inputTokens, value(metric.cachedTokens));
          const outputTokens = value(metric.outputTokens);
          const durationMs = value(metric.durationMs);
          let byConfig = daily.get(date);
          if (!byConfig) { byConfig = new Map(); daily.set(date, byConfig); }
          let aggregate = byConfig.get(configId);
          if (!aggregate) {
            aggregate = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, calls: 0,
              speedOutputTokens: 0, speedDurationMs: 0, estimatedCostUsd: 0, costCalls: 0 };
            byConfig.set(configId, aggregate);
          }
          aggregate.inputTokens += inputTokens;
          aggregate.cachedTokens += cachedTokens;
          aggregate.outputTokens += outputTokens;
          aggregate.calls += 1;
          if (metric.status === 'success' && outputTokens > 0 && durationMs > 0) {
            aggregate.speedOutputTokens += outputTokens;
            aggregate.speedDurationMs += durationMs;
          }
          if (typeof metric.estimatedCostUsd === 'number' && Number.isFinite(metric.estimatedCostUsd) && metric.estimatedCostUsd >= 0) {
            aggregate.estimatedCostUsd += metric.estimatedCostUsd;
            aggregate.costCalls += 1;
          }
        } catch { /* Ignore malformed or incompatible historical rows. */ }
      }
    }
  }
  const today = beijingDate(new Date());
  const firstRecordedDate = [...daily.keys()].sort()[0] || today;
  const startDate = range === 'all' ? firstRecordedDate : (() => {
    const date = new Date(`${today}T00:00:00+08:00`);
    date.setUTCDate(date.getUTCDate() - (Number(range) - 1));
    return beijingDate(date);
  })();
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00+08:00`);
  const end = new Date(`${today}T00:00:00+08:00`);
  while (cursor <= end) {
    dates.push(beijingDate(cursor)); cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const selectedConfigs = [...configs.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  res.json({ timezone: 'Asia/Shanghai', range, startDate, endDate: today, configs: selectedConfigs,
    usdCnyRate: exchangeRate.get(),
    days: dates.map(date => ({ date, byConfig: Object.fromEntries(daily.get(date) || []) })) });
});
app.get('/api/settings', async (_req, res) => {
  const snapshot = codexAccounts.snapshot();
  await Promise.all(snapshot.profiles.map(profile => codexAccounts.refresh(profile.id).catch(() => undefined)));
  res.json({ executionDefaults: store.executionDefaults, providers: providerProfiles.snapshot(), codex: codexAccounts.snapshot() });
});
app.get('/api/providers', (_req, res) => { res.json(providerProfiles.snapshot()); });
app.post('/api/providers', (req, res) => {
  const value = z.object({ id: z.string().min(1).max(100).optional(), label: z.string().trim().min(1).max(100),
    baseUrl: z.string().url(), model: z.string().trim().min(1).max(200), apiKey: z.string().max(500).optional(),
    cacheMode: z.enum(['local', 'previous_response_id']).default('local'), reasoningEffort: z.enum(['none', 'low', 'high', 'max']).default('high'),
    kind: z.enum(['deepseek', 'deepinfra']).optional(), apiFormat: z.enum(['responses', 'chat_completions']).optional(),
    serviceTier: z.enum(['default', 'flex', 'priority']).optional() }).parse(req.body);
  res.status(200).json({ provider: providerProfiles.save(value) });
});
app.delete('/api/providers/:id', (req, res) => { providerProfiles.remove(req.params.id); res.json({ ok: true }); });
app.post('/api/providers/:id/delete', (req, res) => { providerProfiles.remove(req.params.id); res.json({ ok: true }); });
const executionSchema = z.object({ backend: z.enum(['deepseek', 'codex']), profile_id: z.string().optional(), model: z.string().optional(),
  codex_sandbox: z.enum(['danger-full-access', 'workspace-write', 'read-only']).optional() });
app.post('/api/execution/select', async (req, res) => {
  const value = executionSchema.parse(req.body);
  const execution = value.backend === 'deepseek'
    ? await providerProfiles.binding({ backend: 'deepseek', profileId: value.profile_id, model: value.model })
    : await codexAccounts.binding({ backend: 'codex', profileId: value.profile_id, model: value.model, codexSandbox: value.codex_sandbox || store.executionDefaults.codexSandbox });
  store.setExecutionDefaults(execution); res.json({ executionDefaults: execution });
});
app.get('/api/codex', async (_req, res) => {
  const snapshot = codexAccounts.snapshot();
  await Promise.all(snapshot.profiles.map(profile => codexAccounts.refresh(profile.id).catch(() => undefined)));
  res.json({ ...codexAccounts.snapshot(), executionDefaults: store.executionDefaults });
});
app.get('/api/codex/:id', async (req, res) => { res.json(await codexAccounts.describe(req.params.id)); });
app.post('/api/codex', async (req, res) => {
  const { add } = z.object({ add: z.boolean().default(false) }).parse(req.body);
  res.json(await codexAccounts.login(undefined, add));
});
app.post('/api/codex/:id/login', async (req, res) => { res.json(await codexAccounts.login(req.params.id)); });
app.post('/api/codex/:id/logout', async (req, res) => { await codexAccounts.logout(req.params.id); res.json({ ok: true }); });
app.post('/api/codex/:id/refresh', async (req, res) => { res.json(await codexAccounts.describe(req.params.id, true)); });
app.post('/api/codex/defaults', async (req, res) => {
  const value = executionSchema.parse(req.body);
  const execution = value.backend === 'deepseek'
    ? await providerProfiles.binding({ backend: 'deepseek', profileId: value.profile_id, model: value.model })
    : await codexAccounts.binding({ backend: 'codex', profileId: value.profile_id, model: value.model, codexSandbox: value.codex_sandbox || store.executionDefaults.codexSandbox });
  store.setExecutionDefaults(execution); res.json({ executionDefaults: execution });
});
app.post('/api/pricing/holiday-override', (req, res) => {
  const { date, isHoliday } = z.object({ date: z.string().date(), isHoliday: z.boolean() }).parse(req.body);
  store.setHolidayOverride(date, isHoliday);
  res.json({ ok: true });
});
app.get('/api/sessions', (_req, res) => { res.json({ activeSessionId: store.activeSessionId, sessions: store.list() }); });
app.get('/api/sessions/:id', (req, res) => { res.json(store.view(store.get(req.params.id))); });
app.get('/api/sessions/:id/wait', async (req, res) => {
  const { wait_ms } = z.object({ wait_ms: z.coerce.number().int().min(0).max(MAX_AGENT_WAIT_MS).optional() })
    .parse({ wait_ms: req.query.wait_ms });
  const id = req.params.id;
  const startedAt = Date.now();
  const session = store.get(id);
  const waitPolicy = wait_ms === undefined ? store.adaptiveWait(session)
    : { waitMs: wait_ms, elapsedMs: 0, sampleSize: 0, source: 'explicit' as const };
  const waitLimitMs = session.status === 'running' ? waitPolicy.waitMs : 0;
  let waitResult: 'terminal' | 'timeout' | 'not_running' | 'disconnected' = 'not_running';
  if (session.status === 'running' && waitLimitMs > 0) {
    waitResult = await new Promise<'terminal' | 'timeout' | 'disconnected'>(resolve => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        store.off('change', onChange);
        res.off('close', onClose);
      };
      const finish = (result: 'terminal' | 'timeout' | 'disconnected') => {
        if (settled) return;
        settled = true; cleanup(); resolve(result);
      };
      const onChange = (event: { sessionId?: string }) => {
        if (event.sessionId === id && store.get(id).status !== 'running') finish('terminal');
      };
      const onClose = () => finish('disconnected');
      store.on('change', onChange);
      res.once('close', onClose);
      timer = setTimeout(() => finish('timeout'), waitLimitMs);
      // Close the small race between the initial status check and event subscription.
      if (store.get(id).status !== 'running') finish('terminal');
    });
    if (res.destroyed || waitResult === 'disconnected') return;
  }
  res.json({ ...store.view(store.get(id)), waitResult, waitedMs: Date.now() - startedAt,
    waitPolicy: { ...waitPolicy, waitMs: waitLimitMs } });
});
const sessionCreateSchema = z.object({ title: z.string().trim().min(1).max(100).optional(), workspace: z.string().min(1).optional(),
  backend: z.enum(['deepseek', 'codex']).optional(), profile_id: z.string().optional(), model: z.string().optional() });
async function createSession(req: express.Request, res: express.Response, relativeTo = config.workspace) {
  const args = sessionCreateSchema.parse(req.body);
  const workspace = args.workspace ? path.resolve(relativeTo, args.workspace) : config.workspace;
  const backend = args.backend || store.executionDefaults.backend;
  const execution = backend === 'deepseek'
    ? await providerProfiles.binding({ backend: 'deepseek', profileId: args.profile_id || store.executionDefaults.profileId, model: args.model || store.executionDefaults.model })
    : await codexAccounts.binding({ backend: 'codex', profileId: args.profile_id || store.executionDefaults.profileId, model: args.model || store.executionDefaults.model });
  const session = store.create(workspace, args.title, execution);
  res.status(201).json(store.view(session));
}
app.post('/api/sessions/create', (req, res) => createSession(req, res, process.cwd()));
app.post('/api/sessions', async (req, res) => {
  if (req.headers['x-labor-mcp-token'] !== sessionCreationToken)
    return res.status(403).json({ error: '会话只能由 AI 通过 MCP 创建。' });
  await createSession(req, res, config.workspace);
});
app.post('/api/sessions/:id/select', (req, res) => { res.json(store.view(store.select(req.params.id))); });
app.post('/api/sessions/:id/rename', async (req, res) => {
  const { title } = z.object({ title: z.string().trim().min(1).max(100) }).parse(req.body);
  const session = store.get(req.params.id); session.title = title; store.save(session);
  if (session.backend === 'codex') await codexAgent.rename(session);
  res.json(store.view(session));
});
app.post('/api/sessions/:id/send', async (req, res) => {
  const { text, source, wait_ms } = z.object({ text: z.string().min(1).max(100000),
    source: z.enum(['web', 'mcp']).default('web'), wait_ms: z.number().int().min(0).max(MAX_AGENT_WAIT_MS).optional() }).parse(req.body);
  const session = store.get(req.params.id);
  const runner = runnerFor(session);
  let waitPolicy: ReturnType<typeof store.adaptiveWait> | undefined;
  if (session.status === 'running') {
    runner.guide(session, text, source);
    // Acknowledging guidance must not wait for the running task to finish.
  } else {
    // Handle unexpected persistence errors without unhandled promise rejections.
    let run: Promise<void>;
    try { run = runner.start(session, text, source); }
    catch (error) {
      if (error instanceof AppError) return res.status(error.status).json({ error: error.message, contextBudget: session.contextBudget });
      throw error;
    }
    void run.catch(e => console.error('Agent persistence error:', e));
    if (source === 'mcp' && wait_ms === undefined) waitPolicy = store.adaptiveWait(session);
    await runner.wait(session, wait_ms ?? waitPolicy?.waitMs ?? 0);
  }
  res.json({ ...store.view(session), ...(waitPolicy ? { waitPolicy } : {}) });
});
app.post('/api/sessions/:id/cancel', (req, res) => {
  const session = store.get(req.params.id); runnerFor(session).cancel(session); res.json({ ok: true, sessionId: session.id });
});
app.post('/api/shutdown', (_req, res) => {
  res.json({ ok: true }); setImmediate(() => { void stop(); });
});
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Connection', 'keep-alive');
  res.setHeader('Cache-Control', 'no-cache'); res.flushHeaders();
  res.write('data: {"ready":true}\n\n');
  let timer: NodeJS.Timeout | undefined;
  const change = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; res.write('data: {"changed":true}\n\n'); }, 80);
  };
  const heartbeat = setInterval(() => { res.write(': keep-alive\n\n'); }, 20000);
  store.on('change', change);
  req.on('close', () => { clearTimeout(timer); clearInterval(heartbeat); store.off('change', change); });
});
app.use(express.static(path.join(config.projectRoot, 'public'), { etag: true }));
app.use('/api', (_req, res) => { res.status(404).json({ error: '接口不存在。' }); });
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const code = error instanceof AppError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500;
  const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : error.message || '服务错误';
  res.status(code).json({ error: config.apiKey ? message.replaceAll(config.apiKey, '[redacted]') : message });
});
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Labor Agent: ${origin}\nWorkspace: ${config.workspace}\nModel: ${config.model}\nAPI key: ${config.apiKey ? 'configured' : 'not configured'}`);
  openLocalUi(origin);
});
holidayCalendar.start();
exchangeRate.start();
server.on('error', error => { console.error(error.message); process.exit(1); });
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  const hardExit = setTimeout(() => process.exit(1), 6000); hardExit.unref();
  await Promise.all([agent.shutdown(), ...[...deepSeekAgents.values()].map(entry => entry.agent.shutdown()), codexAgent.shutdown()]); server.closeAllConnections(); server.close(() => process.exit(0));
}
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
