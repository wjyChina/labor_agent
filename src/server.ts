import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { Store, AppError } from './store.js';
import { Agent } from './agent.js';
import { baseUrl, serviceId, mcpToken } from './service.js';

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
const store = new Store(config.dataDir), agent = new Agent(config, store);
const sessionCreationToken = mcpToken(config);
const app = express(); app.disable('x-powered-by');
const origin = baseUrl(config), localOrigin = `http://localhost:${config.port}`;
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
const status = () => ({ app: 'labor-agent', version: '0.1.0', serviceId: serviceId(config), pid: process.pid,
  url: origin, configured: !!config.apiKey, model: config.model, baseUrl: config.baseUrl,
  workspace: config.workspace, cacheMode: config.cacheMode, bashPath: agent.tools.bashPath,
  activeSessionId: store.activeSessionId, running: store.list().filter(s => s.status === 'running').length });
app.get('/api/health', (_req, res) => { res.json(status()); });
app.get('/api/state', (_req, res) => { res.json({ ...status(), sessions: store.list(),
  session: store.activeSessionId ? store.view(store.get()) : null }); });
app.get('/api/sessions', (_req, res) => { res.json({ activeSessionId: store.activeSessionId, sessions: store.list() }); });
app.get('/api/sessions/:id', (req, res) => { res.json(store.view(store.get(req.params.id))); });
app.get('/api/sessions/:id/wait', async (req, res) => {
  const { wait_ms } = z.object({ wait_ms: z.coerce.number().int().min(0).max(55000).default(0) })
    .parse({ wait_ms: req.query.wait_ms });
  const id = req.params.id;
  const startedAt = Date.now();
  const session = store.get(id);
  let waitResult: 'terminal' | 'timeout' | 'not_running' | 'disconnected' = 'not_running';
  if (session.status === 'running' && wait_ms > 0) {
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
      timer = setTimeout(() => finish('timeout'), wait_ms);
      // Close the small race between the initial status check and event subscription.
      if (store.get(id).status !== 'running') finish('terminal');
    });
    if (res.destroyed || waitResult === 'disconnected') return;
  }
  res.json({ ...store.view(store.get(id)), waitResult, waitedMs: Date.now() - startedAt });
});
app.post('/api/sessions', (req, res) => {
  if (req.headers['x-labor-mcp-token'] !== sessionCreationToken)
    return res.status(403).json({ error: '会话只能由 AI 通过 MCP 创建。' });
  const args = z.object({ title: z.string().trim().min(1).max(100).optional(), workspace: z.string().min(1).optional() }).parse(req.body);
  const workspace = args.workspace ? path.resolve(config.workspace, args.workspace) : config.workspace;
  res.status(201).json(store.view(store.create(workspace, args.title)));
});
app.post('/api/sessions/:id/select', (req, res) => { res.json(store.view(store.select(req.params.id))); });
app.post('/api/sessions/:id/rename', (req, res) => {
  const { title } = z.object({ title: z.string().trim().min(1).max(100) }).parse(req.body);
  const session = store.get(req.params.id); session.title = title; store.save(session); res.json(store.view(session));
});
app.post('/api/sessions/:id/send', async (req, res) => {
  const { text, source, wait_ms } = z.object({ text: z.string().min(1).max(100000),
    source: z.enum(['web', 'mcp']).default('web'), wait_ms: z.number().int().min(0).max(55000).default(0) }).parse(req.body);
  const session = store.get(req.params.id);
  if (session.status === 'running') {
    agent.guide(session, text, source);
    // Acknowledging guidance must not wait for the running task to finish.
  } else {
    // Handle unexpected persistence errors without unhandled promise rejections.
    void agent.start(session, text, source).catch(e => console.error('Agent persistence error:', e));
    await agent.wait(session, wait_ms);
  }
  res.json(store.view(session));
});
app.post('/api/sessions/:id/cancel', (req, res) => {
  const session = store.get(req.params.id); agent.cancel(session); res.json({ ok: true, sessionId: session.id });
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
});
server.on('error', error => { console.error(error.message); process.exit(1); });
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  const hardExit = setTimeout(() => process.exit(1), 6000); hardExit.unref();
  await agent.shutdown(); server.closeAllConnections(); server.close(() => process.exit(0));
}
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
