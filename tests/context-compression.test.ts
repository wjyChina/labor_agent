import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../src/agent.js';
import { Store } from '../src/store.js';
import { ContextCompression } from '../src/context-compression.js';
import { compressionConfigPatchSchema, resolveCompressionConfig, updateContextPolicy, validateCompressionConfig } from '../src/context-policy.js';
import { fixture, listen, body, json, answer, call } from './helpers.js';

const summary = 'TASK AS OF THIS BLOCK: 保留用户的文件范围、验收标准和已授权工作。\nOpen objectives: 继续实现并验证，尚未完成。\nEvidence: workspace/proof.txt；读取失败时先检查路径。';
const seededHistory = () => [{ role: 'user', content: '原始任务：完成实现，保留既定约束。' },
  ...Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', content: `已消化的历史 ${i}: ${'technical finding '.repeat(450)}` }))];
function validPairs(items: any[]) {
  const pending = new Set<string>();
  for (const item of items) {
    if (item.type === 'function_call') pending.add(item.call_id);
    if (item.type === 'function_call_output') { assert.ok(pending.has(item.call_id), `orphan result ${item.call_id}`); pending.delete(item.call_id); }
  }
  assert.equal(pending.size, 0);
}

test('policies persist, global changes reach inheriting sessions, and session overrides are isolated', () => {
  const f = fixture();
  try {
    const store = new Store(f.dataDir), a = store.create(f.workspace), b = store.create(f.workspace);
    assert.deepEqual(store.contextPolicyFor(a), { mode: 'handoff', strategy: 'long' });
    store.setContextPolicy({ mode: 'compress', strategy: 'long' });
    store.setContextPolicy({ mode: 'compress', strategy: 'short' }, b);
    store.setContextPolicy({ mode: 'handoff', strategy: 'long' });
    const restored = new Store(f.dataDir);
    assert.equal(restored.view(restored.get(a.id)).contextPolicy.mode, 'handoff');
    assert.equal(restored.view(restored.get(b.id)).contextPolicy.strategy, 'short');
    restored.inheritContextPolicy(restored.get(b.id));
    assert.equal(restored.contextPolicyFor(restored.get(b.id)).mode, 'handoff');
    assert.equal(restored.list().find(s => s.id === b.id)?.contextPolicyInherited, true);
  } finally { f.cleanup(); }
});

test('compression config patches preserve other fields, reset to strategy defaults, validate and persist', () => {
  const f = fixture();
  try {
    const store = new Store(f.dataDir), s = store.create(f.workspace);
    const initial = updateContextPolicy(store.contextPolicy, { mode: 'compress', config: {
      triggerRatio: 0.65, preserveRecentTokens: 12000, preserveRecentMessages: 5, summaryMaxTokens: 4096 } });
    store.setContextPolicy(initial);
    const updated = updateContextPolicy(initial, { config: { summaryMaxTokens: 2048 } });
    assert.equal(updated.config!.triggerRatio, 0.65); assert.equal(updated.config!.summaryMaxTokens, 2048);
    store.setContextPolicy(updated, s);
    const restored = new Store(f.dataDir);
    assert.equal(restored.contextPolicy.config!.summaryMaxTokens, 4096);
    assert.equal(restored.contextPolicyFor(restored.get(s.id)).config!.summaryMaxTokens, 2048);
    const defaults = resolveCompressionConfig({ mode: 'compress', strategy: 'long' }, f.config);
    const resetOne = updateContextPolicy(updated, { config: { triggerRatio: null } });
    assert.equal(resolveCompressionConfig(resetOne, f.config).triggerRatio, defaults.triggerRatio);
    assert.equal(resetOne.config!.preserveRecentTokens, 12000);
    assert.deepEqual(updateContextPolicy(updated, { config: null }), { mode: 'compress', strategy: 'long' });
    assert.throws(() => compressionConfigPatchSchema.parse({ triggerRatio: 75 }));
    assert.throws(() => compressionConfigPatchSchema.parse({ preserveRecentMessages: 1.5 }));
    assert.throws(() => compressionConfigPatchSchema.parse({ summaryMaxTokens: -1 }));
    assert.throws(() => compressionConfigPatchSchema.parse({ summaryTokensTypo: 512 }));
    assert.throws(() => validateCompressionConfig({ ...initial, config: { triggerRatio: 0.95 } }, f.config), /安全预警/);
    assert.throws(() => validateCompressionConfig({ ...initial, config: { summaryMaxTokens: f.config.maxOutputTokens + 1 } }, f.config), /输出上限/);
    assert.throws(() => validateCompressionConfig({ ...initial, config: { triggerRatio: 0.1, preserveRecentTokens: 500000 } }, f.config), /触发预算/);
    const smallerModel = resolveCompressionConfig(initial, { ...f.config, maxOutputTokens: 1000 });
    assert.equal(smallerModel.summaryMaxTokens, 1000);
  } finally { f.cleanup(); }
});

test('custom trigger, retention and summary budgets control actual model requests', async () => {
  const f = fixture(), requests: any[] = [];
  const mock = await listen(async (req, res) => {
    const input = await body(req); requests.push(input);
    json(res, answer(input.instructions.startsWith('Write a self-contained summary') ? summary : 'done'));
  });
  try {
    const store = new Store(f.dataDir), s = store.create(f.workspace);
    s.history = seededHistory();
    const recent = structuredClone(s.history.slice(-4));
    store.setContextPolicy({ mode: 'compress', strategy: 'long', config: {
      triggerRatio: 0.7, preserveRecentTokens: 1000, preserveRecentMessages: 5, summaryMaxTokens: 512 } });
    const agent = new Agent({ ...f.config, baseUrl: mock.url, contextLimitTokens: 28000, maxOutputTokens: 1000 }, store);
    await agent.start(s, 'continue', 'mcp');
    assert.equal(s.status, 'idle', s.error);
    const folds = requests.filter(input => input.instructions.startsWith('Write a self-contained summary'));
    assert.equal(folds.length, 1); assert.equal(folds[0].max_output_tokens, 512);
    const normal = requests.at(-1);
    assert.deepEqual(normal.input.slice(-5, -1), recent);
    assert.equal(normal.max_output_tokens, 1000);
    assert.equal(s.contextCompression!.count, 1);
  } finally { await mock.close(); f.cleanup(); }
});

test('config changes during a fold apply before the next compression model call', async () => {
  const f = fixture(), store = new Store(f.dataDir), s = store.create(f.workspace), budgets: number[] = [];
  store.setContextPolicy({ mode: 'compress', strategy: 'long' });
  s.history = [...seededHistory(), ...seededHistory()];
  const mock = await listen(async (req, res) => {
    const input = await body(req);
    if (input.instructions.startsWith('Write a self-contained summary')) {
      budgets.push(input.max_output_tokens);
      if (budgets.length === 1) store.setContextPolicy({ mode: 'compress', strategy: 'long', config: {
        triggerRatio: 0.45, preserveRecentTokens: 512, preserveRecentMessages: 1, summaryMaxTokens: 256 } });
      json(res, answer(summary));
    } else json(res, answer('done'));
  });
  try {
    const agent = new Agent({ ...f.config, baseUrl: mock.url, contextLimitTokens: 28000, maxOutputTokens: 1000 }, store);
    await agent.start(s, 'continue', 'mcp');
    assert.equal(s.status, 'idle', s.error); assert.ok(budgets.length >= 2);
    assert.equal(budgets[0], 1000); assert.equal(budgets[1], 256);
  } finally { await mock.close(); f.cleanup(); }
});

for (const apiFormat of ['responses', 'chat_completions'] as const) {
  test(`compression continues the SAME session, resets provider cache, keeps originals and records usage (${apiFormat})`, async () => {
    const f = fixture(), requests: any[] = [];
    const mock = await listen(async (req, res) => {
      const input = await body(req); requests.push(input);
      const compressing = (input.instructions || input.messages?.[0]?.content || '').startsWith('Write a self-contained summary');
      if (input.input) validPairs(input.input);
      const text = compressing ? summary : '完成，仍在同一会话。';
      if (apiFormat === 'responses') json(res, answer(text, `response_${requests.length}`));
      else json(res, { id: `chat_${requests.length}`, choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 30 } });
    });
    try {
      const config = { ...f.config, baseUrl: mock.url, apiFormat, cacheMode: 'previous_response_id' as const, contextLimitTokens: 28000, maxOutputTokens: 1000 };
      const store = new Store(f.dataDir), s = store.create(f.workspace), agent = new Agent(config, store);
      store.setContextPolicy({ mode: 'compress', strategy: 'long' });
      s.history = seededHistory(); const original = structuredClone(s.history);
      s.previousResponseId = 'old_response'; s.responseCursor = s.history.length;
      const id = s.id;
      await agent.start(s, '继续原任务，不扩大范围。', 'mcp');
      assert.equal(s.status, 'idle', s.error); assert.equal(s.id, id); assert.equal(store.sessions.size, 1);
      assert.ok(s.contextCompression!.count >= 1); assert.ok(s.contextCompression!.afterTokens! < s.contextCompression!.beforeTokens!);
      const normal = requests.filter(r => (r.instructions || r.messages?.[0]?.content || '').startsWith('You are Labor Agent'));
      assert.equal(normal.length, 1); assert.equal(normal[0].previous_response_id, undefined);
      assert.ok(JSON.stringify(normal[0]).includes('继续原任务，不扩大范围。'));
      assert.ok(JSON.stringify(normal[0].tools).includes('context_recall'));
      const compressor = new ContextCompression(config, store), archiveId = s.contextCompression!.lastArchiveId!;
      const recovered = JSON.parse(compressor.recall(s, { archive_id: archiveId, limit: 8000 }));
      assert.ok(recovered.total_chars > 8000); assert.equal(recovered.has_more, true);
      const archive = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'context', id, `${archiveId}.json`), 'utf8'));
      assert.deepEqual(archive.items[0], original[0]);
      const other = store.create(f.workspace);
      assert.throws(() => compressor.recall(other, { archive_id: archiveId }), /当前会话/);
      assert.throws(() => compressor.recall(s, { archive_id: '../escape' }), /无效/);
      assert.equal(new Store(f.dataDir).get(id).contextCompression!.lastArchiveId, archiveId);
      const metrics = fs.readFileSync(path.join(f.dataDir, 'metrics', `${id}.jsonl`), 'utf8').trim().split('\n').map(row => JSON.parse(row));
      assert.ok(metrics.some(m => m.purpose === 'context_compression' && m.status === 'success'));
      assert.ok(s.usage.output > 5);
      assert.ok(!JSON.stringify(store.view(s)).includes('technical finding technical finding'));
    } finally { await mock.close(); f.cleanup(); }
  });
}

test('compression happens DURING tool execution, preserves paired calls, accepts guidance during a fold and finishes', async () => {
  const f = fixture(), requests: any[] = []; let normalCalls = 0, folds = 0;
  let receive!: () => void, release!: () => void;
  const received = new Promise<void>(resolve => { receive = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  fs.writeFileSync(path.join(f.workspace, 'large.txt'), 'evidence\n'.repeat(1500));
  const mock = await listen(async (req, res) => {
    const input = await body(req); requests.push(input); validPairs(input.input);
    if (input.instructions.startsWith('Write a self-contained summary')) {
      if (++folds === 1) { receive(); await gate; }
      json(res, answer(summary, `fold_${folds}`));
    } else if (++normalCalls <= 8) json(res, { id: `step_${normalCalls}`, status: 'completed', output: [call('read', { path: 'large.txt', limit: 1500 }, `read_${normalCalls}`)] });
    else json(res, answer('执行完成。'));
  });
  try {
    const store = new Store(f.dataDir), config = { ...f.config, baseUrl: mock.url, contextLimitTokens: 18000, maxOutputTokens: 1000, toolContextChars: 8000 };
    store.setContextPolicy({ mode: 'compress', strategy: 'long' });
    const s = store.create(f.workspace), agent = new Agent(config, store);
    const running = agent.start(s, '读取证据并完成任务。', 'mcp');
    await received;
    assert.equal(s.contextCompression!.status, 'compressing');
    agent.guide(s, '补充验收：列出证据路径。', 'web'); release(); await running;
    assert.equal(s.status, 'idle', s.error); assert.equal(normalCalls, 9); assert.ok(folds >= 2);
    assert.ok(s.contextCompression!.tier! >= 2);
    assert.equal(s.messages.filter(m => m.tool === 'read').length, 8);
    assert.equal(store.view(s).pendingGuidance, 0);
    assert.ok(requests.at(-1).input.some((i: any) => i.content === '补充验收：列出证据路径。'));
    validPairs(s.history); assert.equal(store.sessions.size, 1);
  } finally { release(); await mock.close(); f.cleanup(); }
});

test('handoff mode still blocks oversized history without a model call; short strategy compresses earlier', async () => {
  const f = fixture(); let calls = 0;
  const mock = await listen(async (req, res) => {
    const input = await body(req); calls++;
    json(res, answer(input.instructions.startsWith('Write a self-contained summary') ? summary : 'done'));
  });
  try {
    const config = { ...f.config, baseUrl: mock.url, contextLimitTokens: 28000, maxOutputTokens: 1000 };
    const store = new Store(f.dataDir), agent = new Agent(config, store), blocked = store.create(f.workspace);
    blocked.history = [...seededHistory(), ...seededHistory()];
    assert.throws(() => agent.start(blocked, 'continue', 'mcp'), /新.*session|新的 session/); assert.equal(calls, 0);
    for (const strategy of ['long', 'short'] as const) {
      const s = store.create(f.workspace); s.history = seededHistory().slice(0, 5);
      store.setContextPolicy({ mode: 'compress', strategy }, s);
      await agent.start(s, 'continue', 'mcp'); assert.equal(s.status, 'idle', s.error);
      assert.equal(Boolean(s.contextCompression?.count), strategy === 'short');
    }
  } finally { await mock.close(); f.cleanup(); }
});

test('failed and cancelled summaries preserve the old context and never execute task tools', async () => {
  const f = fixture(); let agent: Agent, session: ReturnType<Store['create']>, cancel = false;
  const mock = await listen(async (req, res) => {
    await body(req);
    if (cancel) { agent.cancel(session); res.end(); }
    else json(res, answer(''));
  });
  try {
    const store = new Store(f.dataDir);
    agent = new Agent({ ...f.config, baseUrl: mock.url, contextLimitTokens: 28000, maxOutputTokens: 1000 }, store);
    store.setContextPolicy({ mode: 'compress', strategy: 'long' });
    for (cancel of [false, true]) {
      session = store.create(f.workspace); session.history = seededHistory(); const original = structuredClone(session.history);
      await agent.start(session, 'continue', 'mcp');
      assert.equal(session.status, cancel ? 'cancelled' : 'error');
      assert.deepEqual(session.history.slice(0, original.length), original);
      assert.equal(session.contextCompression!.count, 0); assert.equal(session.contextCompression!.status, 'idle');
      assert.equal(session.messages.filter(m => m.role === 'tool').length, 0);
    }
  } finally { await mock.close(); f.cleanup(); }
});

test('provider-confirmed context overflow triggers a bounded recovery fold in the same session', async () => {
  const f = fixture(); let normal = 0, folds = 0;
  const mock = await listen(async (req, res) => {
    const input = await body(req);
    if (input.instructions.startsWith('Write a self-contained summary')) { folds++; json(res, answer(summary)); }
    else if (++normal === 1) json(res, { error: 'maximum context length exceeded' }, 400);
    else json(res, answer('recovered'));
  });
  try {
    const store = new Store(f.dataDir), s = store.create(f.workspace);
    store.setContextPolicy({ mode: 'compress', strategy: 'long' });
    s.history = seededHistory().slice(0, 6);
    const agent = new Agent({ ...f.config, baseUrl: mock.url, contextLimitTokens: 40000, maxOutputTokens: 1000 }, store);
    await agent.start(s, 'continue', 'mcp');
    assert.equal(s.status, 'idle', s.error); assert.equal(normal, 2); assert.equal(folds, 1); assert.equal(store.sessions.size, 1);
  } finally { await mock.close(); f.cleanup(); }
});
