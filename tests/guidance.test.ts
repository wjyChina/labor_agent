import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../src/agent.js';
import { Store } from '../src/store.js';
import { fixture, listen, body, json, call, answer } from './helpers.js';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open: () => open() };
}

for (const cacheMode of ['local', 'previous_response_id'] as const) {
  test(`guidance while model runs skips stale tools, keeps FIFO and valid call pairs (${cacheMode})`, { timeout: 10000 }, async () => {
    const f = fixture(), received = gate(), release = gate(), requests: any[] = [];
    const mock = await listen(async (req, res) => {
      requests.push(await body(req));
      if (requests.length === 1) {
        received.open(); await release.promise;
        json(res, { id: 'response_old_plan', status: 'completed', output: [call('write', { path: 'stale.txt', content: 'old plan' })] });
      } else json(res, answer('已按最新引导调整。'));
    });
    const store = new Store(f.dataDir), s = store.create(f.workspace);
    const agent = new Agent({ ...f.config, baseUrl: mock.url, cacheMode }, store);
    try {
      const running = agent.start(s, '原任务', 'mcp'); await received.promise;
      agent.guide(s, '先只检查，不要写文件。', 'web');
      agent.guide(s, '验收时说明检查依据。', 'mcp');
      assert.equal(store.view(s).pendingGuidance, 2);
      assert.equal(s.history.length, 1); // Do not mutate input history while a request is in flight.
      release.open(); await running;
      assert.equal(s.status, 'idle'); assert.equal(store.view(s).pendingGuidance, 0);
      assert.equal(fs.existsSync(path.join(f.workspace, 'stale.txt')), false);
      assert.equal(s.messages.find(m => m.role === 'tool')?.state, 'skipped');
      assert.deepEqual(requests[1].input.filter((i: any) => i.role === 'user').slice(-2).map((i: any) => i.content), ['先只检查，不要写文件。', '验收时说明检查依据。']);
      assert.equal(s.history.filter(i => i.type === 'function_call').length, s.history.filter(i => i.type === 'function_call_output').length);
      assert.equal(s.messages.filter(m => m.delivery === 'applied').length, 2);
      if (cacheMode === 'previous_response_id') {
        assert.equal(requests[1].previous_response_id, 'response_old_plan');
        assert.equal(requests[1].input.length, 3); // The skipped result plus two new guidance messages.
      }
    } finally { release.open(); await agent.shutdown(); await mock.close(); f.cleanup(); }
  });
}

test('guidance lets the active tool finish, skips later calls and replans with its result', { timeout: 10000 }, async () => {
  const f = fixture(), entered = gate(), release = gate(), requests: any[] = [];
  const mock = await listen(async (req, res) => {
    requests.push(await body(req));
    json(res, requests.length === 1 ? { id: 'tools', status: 'completed', output: [
      call('bash', { command: "printf 'finished' > current.txt" }),
      call('write', { path: 'stale.txt', content: 'should not execute' }),
    ] } : answer('当前命令完成，已按引导重新安排。'));
  });
  const store = new Store(f.dataDir), s = store.create(f.workspace), agent = new Agent({ ...f.config, baseUrl: mock.url }, store);
  const execute = agent.tools.execute.bind(agent.tools);
  agent.tools.execute = async (...args) => { if (args[0] === 'bash') { entered.open(); await release.promise; } return execute(...args); };
  try {
    const running = agent.start(s, '执行任务', 'web'); await entered.promise;
    agent.guide(s, '当前命令结束后只汇报，不要继续写其他文件。', 'web');
    release.open(); await running;
    assert.equal(fs.readFileSync(path.join(f.workspace, 'current.txt'), 'utf8'), 'finished');
    assert.equal(fs.existsSync(path.join(f.workspace, 'stale.txt')), false);
    assert.equal(s.messages.find(m => m.tool === 'bash')?.state, 'done');
    assert.equal(s.messages.find(m => m.tool === 'write')?.state, 'skipped');
    assert.equal(requests[1].input.at(-1).role, 'user'); assert.equal(s.status, 'idle');
  } finally { release.open(); await agent.shutdown(); await mock.close(); f.cleanup(); }
});

test('guidance received during a final reply starts another model step before ending the turn', { timeout: 10000 }, async () => {
  const f = fixture(), received = gate(), release = gate(); let count = 0;
  const mock = await listen(async (req, res) => {
    await body(req);
    if (++count === 1) { received.open(); await release.promise; json(res, answer('旧回复')); }
    else json(res, answer('补充核验也已完成。'));
  });
  const store = new Store(f.dataDir), s = store.create(f.workspace), agent = new Agent({ ...f.config, baseUrl: mock.url }, store);
  try {
    const running = agent.start(s, '原任务', 'web'); await received.promise;
    agent.guide(s, '结束前再检查一项条件。', 'web'); release.open(); await running;
    assert.equal(count, 2); assert.equal(s.messages.at(-1)?.text, '补充核验也已完成。'); assert.equal(s.status, 'idle');
    assert.throws(() => agent.guide(s, '已结束', 'web'), /未在执行/);
  } finally { release.open(); await agent.shutdown(); await mock.close(); f.cleanup(); }
});

test('cancelled guidance persists across restart and is applied once before the next message', { timeout: 10000 }, async () => {
  const f = fixture(), received = gate(), release = gate(), requests: any[] = [];
  const mock = await listen(async (req, res) => {
    requests.push(await body(req));
    if (requests.length === 1) { received.open(); await release.promise; }
    json(res, answer('继续成功。'));
  });
  const config = { ...f.config, baseUrl: mock.url }, store = new Store(f.dataDir), s = store.create(f.workspace), agent = new Agent(config, store);
  let resumed: Agent | undefined;
  try {
    const running = agent.start(s, '原任务', 'web'); await received.promise;
    agent.guide(s, '保留这条要求。', 'web'); agent.cancel(s); await running;
    assert.equal(s.status, 'cancelled'); assert.equal(store.view(s).pendingGuidance, 1);
    release.open();
    const restored = new Store(f.dataDir), session = restored.get(s.id); resumed = new Agent(config, restored);
    assert.equal(restored.view(session).pendingGuidance, 1);
    await resumed.start(session, '继续', 'mcp');
    assert.deepEqual(requests.at(-1).input.filter((i: any) => i.role === 'user').map((i: any) => i.content), ['原任务', '保留这条要求。', '继续']);
    assert.equal(restored.view(session).pendingGuidance, 0); assert.equal(session.status, 'idle');
  } finally { release.open(); await agent.shutdown(); await resumed?.shutdown(); await mock.close(); f.cleanup(); }
});
