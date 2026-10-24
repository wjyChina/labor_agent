import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

export function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labor-agent-test-'));
  const workspace = path.join(dir, 'workspace'), dataDir = path.join(dir, 'data');
  fs.mkdirSync(workspace); fs.mkdirSync(dataDir);
  const config = loadConfig({ LABOR_API_KEY: 'test-only-not-real', LABOR_WORKSPACE: workspace,
    LABOR_DATA_DIR: dataDir, LABOR_REASONING_EFFORT: 'none' });
  return { dir, workspace, dataDir, config, cleanup() {
    assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(), 'labor-agent-test-')));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}
export async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  return { server, port, url: `http://127.0.0.1:${port}`,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
export async function body(req: http.IncomingMessage) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export const answer = (text: string, id = 'resp_test') => ({ id, status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } } });
export function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
}
export const call = (name: string, args: unknown, id = name) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: `call_${id}` });
