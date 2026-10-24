import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../dist/config.js';
import { health, ensureService, request } from '../dist/service.js';
const config = loadConfig(), action = process.argv[2] || 'status';
async function stop() {
  // The old server may still use the port from before the .env edit.
  const lockPath = path.join(config.dataDir, 'server.lock');
  let oldConfig = config;
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (Number.isInteger(lock.port)) oldConfig = { ...config, port: lock.port };
  }
  const running = await health(oldConfig);
  if (!running) { console.log('Labor Agent 未运行。'); return; }
  await request(oldConfig, '/api/shutdown', {});
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!await health(oldConfig)) { console.log('Labor Agent 已停止。'); return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('服务仍在停止，请稍后重试。');
}
try {
  if (action === 'stop' || action === 'restart') await stop();
  if (action === 'start' || action === 'restart') {
    const result = await ensureService(config); console.log(`Labor Agent: ${result.url}\n模型: ${result.model}\nAPI Key: ${result.configured ? '已配置' : '未配置'}`);
  } else if (action === 'status') {
    const result = await health(config); console.log(result ? JSON.stringify(result, null, 2) : 'Labor Agent 未运行。');
  } else if (action !== 'stop') throw new Error('用法：node scripts/service.mjs start|stop|restart|status');
} catch (e) { console.error(e.message); process.exitCode = 1; }
