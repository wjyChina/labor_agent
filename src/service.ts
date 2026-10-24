import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Config } from './config.js';

export function serviceId(c: Config) {
  return createHash('sha256').update(path.resolve(c.dataDir).toLowerCase()).digest('hex').slice(0, 20);
}
export const baseUrl = (c: Config) => `http://127.0.0.1:${c.port}`;
export function mcpToken(c: Config) {
  const file = path.join(c.dataDir, 'mcp-token');
  fs.mkdirSync(c.dataDir, { recursive: true });
  try { fs.writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  return fs.readFileSync(file, 'utf8').trim();
}
export async function health(c: Config): Promise<any | null> {
  try {
    const res = await fetch(`${baseUrl(c)}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.app !== 'labor-agent' || data.serviceId !== serviceId(c))
      throw new Error(`端口 ${c.port} 已被其他服务占用，请修改 LABOR_PORT。`);
    return data;
  } catch (e) {
    if (e instanceof Error && e.message.includes('已被其他服务占用')) throw e;
    return null;
  }
}
export async function ensureService(c: Config) {
  const existing = await health(c);
  if (existing) return existing;
  fs.mkdirSync(c.dataDir, { recursive: true });
  const log = fs.openSync(path.join(c.dataDir, 'server.log'), 'a');
  try {
    const child = spawn(process.execPath, [path.join(c.projectRoot, 'dist/server.js')], {
      cwd: c.projectRoot, env: process.env, detached: true, windowsHide: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', e => { console.error(`Labor Agent 启动失败：${e.message}`); }); child.unref();
  } finally { fs.closeSync(log); }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const status = await health(c);
    if (status) return status;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`服务未能启动。请查看 ${path.join(c.dataDir, 'server.log')}`);
}
export async function request(c: Config, route: string, body?: unknown, timeout = 65000) {
  const response = await fetch(`${baseUrl(c)}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Labor-MCP-Token': mcpToken(c) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
