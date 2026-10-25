import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../src/agent.js';
import { Store } from '../src/store.js';
import { ResponsesProvider } from '../src/provider.js';
import { fixture, listen, body, json, call, answer } from './helpers.js';

test('agent executes all four tools, locally replays full Responses history and persists sessions', async () => {
  const f = fixture(); const requests: any[] = [];
  const mock = await listen(async (req, res) => {
    const b = await body(req); requests.push(b);
    if (requests.length === 1) json(res, { id: 'resp_tools', status: 'completed', output: [
      call('write', { path: 'note.txt', content: 'hello' }), call('read', { path: 'note.txt' }),
      call('edit', { path: 'note.txt', old_text: 'hello', new_text: '你好' }), call('bash', { command: 'cat note.txt' }),
    ] });
    else json(res, answer(requests.length === 2 ? '已完成并检查。' : '我记得上文。', `resp_${requests.length}`));
  });
  try {
    const store = new Store(f.dataDir), agent = new Agent({ ...f.config, baseUrl: mock.url }, store);
    const s = store.create(f.workspace);
    await agent.start(s, '写入并检查文件', 'mcp');
    assert.equal(s.status, 'idle'); assert.equal(s.messages[0].source, 'mcp');
    assert.equal(s.messages.filter(m => m.role === 'tool').length, 4);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'note.txt'), 'utf8'), '你好');
    assert.ok(requests[1].input.some((x: any) => x.type === 'function_call_output' && x.output.includes('你好')));
    assert.equal(requests[1].previous_response_id, undefined); assert.equal(requests[1].store, undefined);
    const length = s.history.length;
    await agent.start(s, '记得刚才的内容吗？', 'web');
    assert.equal(requests[2].input.length, length + 1); assert.ok(s.usage.cached > 0);
    const second = store.create(f.workspace, '独立会话'); assert.equal(second.history.length, 0);
    const restored = new Store(f.dataDir);
    assert.equal(restored.activeSessionId, second.id); assert.equal(restored.get(s.id).messages.at(-1)?.text, '我记得上文。');
    assert.equal('history' in restored.view(restored.get(s.id)), false);
  } finally { await mock.close(); f.cleanup(); }
});
test('SSE handles UTF-8, split CRLF boundaries, text deltas and final usage', async () => {
  const f = fixture(); let captured: any;
  const mock = await listen(async (req, res) => {
    captured = await body(req); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(`: keepalive\r\n\r\nevent: response.output_text.delta\r\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '你好' })}\r\n\r\ndata: ${JSON.stringify({ type: 'response.completed', response: answer('你好') })}\r\n\r\n`);
    for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7)); res.end();
  });
  try {
    let delta = '';
    const result = await new ResponsesProvider({ ...f.config, baseUrl: mock.url }).create([{ role: 'user', content: '你好' }], 'test', undefined, new AbortController().signal, text => { delta += text; });
    assert.equal(delta, '你好'); assert.equal(result.usage.output_tokens, 5); assert.equal(captured.tools.length, 5);
  } finally { await mock.close(); f.cleanup(); }
});
test('previous_response_id sends only new items and falls back when server context expires', async () => {
  const f = fixture(), requests: any[] = [];
  const mock = await listen(async (req, res) => {
    const b = await body(req); requests.push(b);
    if (requests.length === 2) json(res, { error: { message: 'previous_response_id not found' } }, 404);
    else json(res, answer('回复', `resp_${requests.length}`));
  });
  try {
    const store = new Store(f.dataDir), agent = new Agent({ ...f.config, baseUrl: mock.url, cacheMode: 'previous_response_id' }, store);
    const s = store.create(f.workspace);
    await agent.start(s, 'first', 'web'); await agent.start(s, 'second', 'web');
    assert.equal(s.status, 'idle'); assert.equal(requests[1].previous_response_id, 'resp_1'); assert.equal(requests[1].input.length, 1);
    assert.equal(requests[2].previous_response_id, undefined); assert.equal(requests[2].input.length, 3);
    assert.equal(requests[0].store, true); assert.equal(requests[2].instructions, requests[0].instructions);
  } finally { await mock.close(); f.cleanup(); }
});
test('cancellation kills Bash, closes pending call pairs and allows another turn', async () => {
  const f = fixture(); let count = 0;
  const mock = await listen(async (req, res) => {
    await body(req);
    json(res, ++count === 1 ? { id: 'resp_sleep', status: 'completed', output: [call('bash', { command: 'sleep 20' }), call('write', { path: 'never.txt', content: 'bad' })] } : answer('继续成功'));
  });
  try {
    const store = new Store(f.dataDir), agent = new Agent({ ...f.config, baseUrl: mock.url }, store), s = store.create(f.workspace);
    const running = agent.start(s, 'sleep', 'mcp');
    assert.throws(() => agent.start(s, 'duplicate', 'web'), /正在执行/);
    while (!s.messages.some(m => m.role === 'tool')) await new Promise(resolve => setTimeout(resolve, 10));
    agent.cancel(s); await running;
    assert.equal(s.status, 'cancelled'); assert.equal(fs.existsSync(path.join(f.workspace, 'never.txt')), false);
    assert.equal(s.history.filter(i => i.type === 'function_call_output').length, 2);
    await agent.start(s, 'continue', 'web'); assert.equal(s.status, 'idle');
  } finally { await mock.close(); f.cleanup(); }
});
test('restart repairs interrupted calls and marks tool state, never silently dropping history', () => {
  const f = fixture();
  try {
    const store = new Store(f.dataDir), s = store.create(f.workspace);
    s.status = 'running'; s.previousResponseId = 'old'; s.history.push(call('write', { path: 'x', content: 'x' }));
    store.add(s, { role: 'tool', tool: 'write', text: '', state: 'running' });
    store.add(s, { role: 'user', text: '服务重启后仍需处理的引导', kind: 'guidance', delivery: 'queued' });
    const recoveredStore = new Store(f.dataDir), restored = recoveredStore.get(s.id);
    assert.equal(restored.status, 'error'); assert.equal(restored.history.at(-1)?.type, 'function_call_output');
    assert.equal(restored.previousResponseId, undefined); assert.equal(restored.messages[0].state, 'error');
    assert.equal(recoveredStore.view(restored).pendingGuidance, 1);
  } finally { f.cleanup(); }
});
test('HTTP and incomplete stream errors are visible; API key never appears in transcript', async () => {
  const f = fixture(); let count = 0;
  const mock = await listen(async (req, res) => {
    await body(req);
    if (++count === 1) json(res, { error: `denied ${f.config.apiKey}` }, 401);
    else { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'); }
  });
  try {
    const store = new Store(f.dataDir), agent = new Agent({ ...f.config, baseUrl: mock.url }, store), s = store.create(f.workspace);
    await agent.start(s, 'first', 'web'); assert.equal(s.status, 'error'); assert.match(s.error!, /401/);
    assert.ok(!JSON.stringify(store.view(s)).includes(f.config.apiKey));
    await agent.start(s, 'second', 'web'); assert.equal(s.status, 'error'); assert.match(s.error!, /提前断开/);
    assert.equal(s.messages.find(m => m.text === 'partial')?.state, 'error');
  } finally { await mock.close(); f.cleanup(); }
});
test('tool loops continue past 40 model calls and finish normally', async () => {
  const f = fixture(); let count = 0;
  const mock = await listen(async (req, res) => {
    await body(req);
    if (++count <= 41) json(res, { id: `loop_${count}`, status: 'completed', output: [call('read', { path: '.' }, String(count))] });
    else json(res, answer('已完成', `loop_${count}`));
  });
  try {
    const store = new Store(f.dataDir), agent = new Agent({ ...f.config, baseUrl: mock.url }, store), s = store.create(f.workspace);
    await agent.start(s, 'loop', 'web');
    assert.equal(count, 42); assert.equal(s.status, 'idle');
    assert.equal(s.history.filter(i => i.type === 'function_call').length, s.history.filter(i => i.type === 'function_call_output').length);
  } finally { await mock.close(); f.cleanup(); }
});

for (const cacheMode of ['local', 'previous_response_id'] as const) {
  test(`large tool results stay archived and can be paged without rerunning (${cacheMode})`, async () => {
    const f = fixture(), requests: any[] = [];
    const mock = await listen(async (req, res) => {
      const b = await body(req); requests.push(b);
      if (requests.length === 1) json(res, { id: 'large_output', status: 'completed', output: [
        call('bash', { command: "printf 'head-%s\\n' {1..2000}; printf 'FAILURE_TAIL' >&2; exit 7" }),
      ] });
      else if (requests.length === 2) {
        const result = b.input.find((x: any) => x.type === 'function_call_output');
        const preview = JSON.parse(result.output);
        assert.equal(preview.exit_code, 7); assert.equal(preview.stderr, 'FAILURE_TAIL');
        assert.equal(preview.context_truncated, true); assert.ok(result.output.length <= 1000);
        assert.ok(!result.output.includes('head-1000'));
        json(res, { id: 'detail_page', status: 'completed', output: [
          call('tool_result_get', { result_id: preview.result_id, offset: 10000, limit: 256 }),
        ] });
      } else json(res, answer('已读取失败证据，无需重新执行。'));
    });
    try {
      const store = new Store(f.dataDir), agent = new Agent({ ...f.config, cacheMode, baseUrl: mock.url, toolContextChars: 1000 }, store);
      const s = store.create(f.workspace);
      await agent.start(s, '读取长命令结果中的失败证据', 'mcp');
      assert.equal(s.status, 'idle'); assert.equal(requests.length, 3);
      const captured = s.messages.find(m => m.tool === 'bash')!;
      assert.ok(captured.text.length > 10000); assert.match(captured.text, /head-1000/);
      const detail = s.messages.find(m => m.tool === 'tool_result_get')!;
      const page = JSON.parse(detail.text);
      assert.equal(page.text, captured.text.slice(10000, 10256));
      assert.equal(page.next_offset, 10256); assert.equal(page.has_more, true);
      assert.equal(s.messages.filter(m => m.tool === 'bash').length, 1);
      assert.equal(s.history.filter(i => i.type === 'function_call').length, s.history.filter(i => i.type === 'function_call_output').length);
      assert.equal(new Store(f.dataDir).get(s.id).messages.find(m => m.id === captured.id)?.text, captured.text);
      if (cacheMode === 'previous_response_id') {
        assert.equal(requests[1].previous_response_id, 'large_output'); assert.equal(requests[1].input.length, 1);
        assert.equal(requests[2].previous_response_id, 'detail_page'); assert.equal(requests[2].input.length, 1);
      } else {
        assert.deepEqual(requests[2].input.slice(0, requests[1].input.length), requests[1].input);
      }
    } finally { await mock.close(); f.cleanup(); }
  });
}

test('result lookup cannot read another session and never repairs history by deleting calls', async () => {
  const f = fixture(); const store = new Store(f.dataDir);
  const other = store.create(f.workspace);
  const archived = store.add(other, { role: 'tool', tool: 'read', text: 'other-session-data', state: 'done' });
  let count = 0;
  const mock = await listen(async (req, res) => {
    const b = await body(req);
    if (++count === 1) json(res, { id: 'lookup', status: 'completed', output: [call('tool_result_get', { result_id: archived.id })] });
    else {
      const output = b.input.find((x: any) => x.type === 'function_call_output').output;
      assert.match(output, /当前会话中不存在/); assert.ok(!output.includes('other-session-data'));
      json(res, answer('当前会话没有该结果。'));
    }
  });
  try {
    const agent = new Agent({ ...f.config, baseUrl: mock.url }, store), s = store.create(f.workspace);
    await agent.start(s, '读取结果', 'mcp'); assert.equal(s.status, 'idle');
    assert.equal(s.messages.find(m => m.tool === 'tool_result_get')?.state, 'error');
  } finally { await mock.close(); f.cleanup(); }
});
