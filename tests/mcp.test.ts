import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, listen, body, json, answer, call } from './helpers.js';

test('MCP auto-starts backend and shares sessions/transcripts with HTTP UI, rejects cross-site writes', async () => {
  const f = fixture();
  const requests: any[] = [];
  let releaseSteering!: () => void, sawSteering!: () => void;
  const pauseSteering = new Promise<void>(resolve => { releaseSteering = resolve; });
  const steeringRequest = new Promise<void>(resolve => { sawSteering = resolve; });
  const mock = await listen(async (req, res) => {
    const input = await body(req); requests.push(input);
    const userTurns = input.input.filter((item: any) => item.role === 'user').length;
    if (input.input.at(-1)?.role === 'user') {
      if (userTurns === 3) {
        sawSteering(); await pauseSteering;
        json(res, { id: 'stale_plan', status: 'completed', output: [call('write', { path: 'stale.txt', content: 'old' }, 'stale')] }); return;
      }
      const output = userTurns === 1
        ? [call('write', { path: 'proof.txt', content: 'alpha' }, 'create'), call('bash', { command: 'cat proof.txt' }, 'verify-create')]
        : userTurns === 2 ? [call('edit', { path: 'proof.txt', old_text: 'alpha', new_text: 'beta' }, 'correct'), call('read', { path: 'proof.txt' }, 'verify-correction')]
        : [call('write', { path: 'guided.txt', content: 'new direction' }, 'guided')];
      json(res, { id: `response_tools_${userTurns}`, status: 'completed', output });
    } else json(res, answer(userTurns === 1 ? 'MCP → DeepSeek → UI，已收到。' : '验收通过：proof.txt 内容已改为 beta，并已读取核验。', `response_done_${userTurns}`));
  });
  const reserve = await listen((_req, res) => res.end()); const port = reserve.port; await reserve.close();
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(f.config.projectRoot, 'dist/mcp.js')],
    cwd: f.workspace, stderr: 'pipe', env: { ...env, LABOR_API_KEY: f.config.apiKey, LABOR_BASE_URL: mock.url,
      LABOR_WORKSPACE: f.workspace, LABOR_DATA_DIR: f.dataDir, LABOR_PORT: String(port), LABOR_REASONING_EFFORT: 'none',
      LABOR_CODEX_COMMAND: path.join(f.dir, 'not-installed-codex') } });
  const client = new Client({ name: 'labor-test', version: '1.0.0' }); let pid: number | undefined;
  const tool = async (name: string, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse((result.content as any)[0].text);
  };
  try {
    await client.connect(transport);
    const list = await client.listTools(); assert.equal(list.tools.length, 10);
    assert.ok(list.tools.some(tool => tool.name === 'agent_wait'));
    const start = await tool('agent_start'); pid = start.pid; assert.equal(start.configured, true);
    const a = await tool('session_create', { title: 'MCP 测试' });
    const b = await tool('session_create', { title: '第二会话' });
    assert.equal((await tool('context_policy')).defaults.mode, 'handoff');
    await tool('context_policy', { mode: 'compress' });
    assert.equal((await tool('context_policy', { session_id: a.id })).effective.strategy, 'long');
    const configured = await tool('context_policy', { config: { triggerRatio: 0.7, preserveRecentTokens: 12000,
      preserveRecentMessages: 4, summaryMaxTokens: 4096 } });
    assert.equal(configured.resolved.triggerRatio, 0.7); assert.equal(configured.resolved.summaryMaxTokens, 4096);
    const settings = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json() as any;
    assert.equal(settings.contextSettings.global.effective.config.preserveRecentMessages, 4);
    assert.equal(settings.contextSettings.global.presets.long.triggerRatio, 0.75);
    assert.ok(settings.contextSettings.global.limits.maxOutputTokens >= 4096);
    await tool('context_policy', { session_id: b.id, mode: 'compress', strategy: 'short' });
    await tool('context_policy', { session_id: b.id, config: { triggerRatio: 0.6, summaryMaxTokens: 1024 } });
    const policyResponse = await fetch(`http://127.0.0.1:${port}/api/context-policy?session_id=${b.id}`);
    const policyBody = await policyResponse.json() as any;
    assert.equal(policyBody.effective.strategy, 'short'); assert.equal(policyBody.resolved.summaryMaxTokens, 1024);
    assert.equal((await tool('context_policy')).resolved.triggerRatio, 0.7);
    const invalid = await fetch(`http://127.0.0.1:${port}/api/context-policy`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { triggerRatio: 0.95 } }) });
    assert.equal(invalid.status, 400); assert.equal((await tool('context_policy')).resolved.triggerRatio, 0.7);
    const resetOne = await tool('context_policy', { session_id: b.id, config: { triggerRatio: null } });
    assert.equal(resetOne.resolved.triggerRatio, 0.45); assert.equal(resetOne.resolved.summaryMaxTokens, 1024);
    await tool('context_policy', { session_id: b.id, inherit: true });
    assert.equal((await tool('context_policy', { session_id: b.id })).inherited, true);
    assert.equal((await tool('context_policy', { session_id: b.id })).resolved.summaryMaxTokens, 4096);
    assert.equal((await tool('context_policy', { config: null })).resolved.triggerRatio, 0.75);
    await tool('context_policy', { mode: 'handoff' });
    await tool('session_select', { session_id: a.id });
    const task = '请创建 proof.txt。验收标准：内容为 alpha，提供实际读取的证据。请自主执行。';
    const sent = await tool('agent_send', { session_id: a.id, text: task, wait_ms: 5000 });
    assert.equal(sent.status, 'idle'); assert.equal(sent.messages.at(-1).text, 'MCP → DeepSeek → UI，已收到。');
    const base = `http://127.0.0.1:${port}`;
    const state = await (await fetch(`${base}/api/state`)).json() as any;
    assert.equal(state.activeSessionId, a.id); assert.equal(state.session.messages[0].source, 'mcp'); assert.equal(state.sessions.length, 2);
    assert.equal(state.session.messages[0].text, task);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'proof.txt'), 'utf8'), 'alpha');
    assert.ok(state.session.messages.some((message: any) => message.role === 'tool' && message.tool === 'bash' && message.text.includes('alpha')));
    assert.ok(!JSON.stringify(state).includes(f.config.apiKey));
    assert.match(await (await fetch(base)).text(), /Labor Agent/);
    assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"title":"网页不能创建","source":"mcp"}' })).status, 403);
    assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    const controller = new AbortController();
    const events = await fetch(`${base}/api/events`, { signal: controller.signal });
    const first = await events.body!.getReader().read(); assert.match(new TextDecoder().decode(first.value), /ready/); controller.abort();
    await tool('session_select', { session_id: b.id });
    assert.equal((await tool('agent_status')).id, b.id);
    const feedback = '验收条件变更：proof.txt 内容应为 beta。请在原任务基础上修正并重新验证。';
    const corrected = await tool('agent_send', { session_id: a.id, text: feedback, wait_ms: 5000 });
    assert.equal(corrected.status, 'idle');
    assert.equal(fs.readFileSync(path.join(f.workspace, 'proof.txt'), 'utf8'), 'beta');
    assert.ok(requests.at(-1).input.some((item: any) => item.role === 'user' && item.content === task));
    assert.ok(requests.at(-1).input.some((item: any) => item.role === 'user' && item.content === feedback));
    assert.equal((await tool('agent_status')).id, b.id);
    const transcript = await tool('session_get', { session_id: a.id });
    assert.equal(transcript.totalMessages, 8);
    assert.ok(transcript.messages.some((message: any) => message.tool === 'read' && message.text.includes('beta')));
    const started = await tool('agent_send', { session_id: a.id, text: '开始引导验证任务', wait_ms: 0 });
    assert.equal(started.status, 'running'); await steeringRequest;
    const guided = await fetch(`${base}/api/sessions/${a.id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '改为写 guided.txt，不要执行旧计划。', source: 'web' }) });
    const queued = await guided.json() as any;
    assert.equal(guided.status, 200); assert.equal(queued.pendingGuidance, 1);
    assert.equal(queued.messages.at(-1).kind, 'guidance'); assert.equal(queued.messages.at(-1).delivery, 'queued');
    releaseSteering();
    let progress;
    const deadline = Date.now() + 5000;
    do { progress = await tool('agent_status', { session_id: a.id, wait_ms: 100 }); } while (progress.status === 'running' && Date.now() < deadline);
    assert.equal(progress.status, 'idle'); assert.equal(progress.pendingGuidance, 0);
    assert.equal(fs.existsSync(path.join(f.workspace, 'stale.txt')), false);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'guided.txt'), 'utf8'), 'new direction');
    await tool('agent_cancel');
  } finally {
    releaseSteering();
    const mcpPid = transport.pid;
    await client.close();
    // The SDK's forced-close path can return before the process exits on
    // Windows. Its cwd is this fixture: await release before deleting it.
    if (mcpPid) for (let n = 0; n < 60; n++) {
      try { process.kill(mcpPid, 0); await new Promise(resolve => setTimeout(resolve, 50)); } catch { break; }
    }
    // This process was created by this test, and its private data directory identifies it.
    if (pid) {
      const lock = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'server.lock'), 'utf8'));
      assert.equal(lock.pid, pid);
      const stopped = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(stopped.status, 200);
      for (let n = 0; n < 40; n++) { try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 50)); } catch { break; } }
    }
    await mock.close(); f.cleanup();
  }
});
