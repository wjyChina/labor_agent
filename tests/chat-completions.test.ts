import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../src/agent.js';
import { Store } from '../src/store.js';
import { ResponsesProvider } from '../src/provider.js';
import { ProviderProfiles } from '../src/provider-profiles.js';
import { fixture, listen, body, json } from './helpers.js';

test('Chat Completions streams fragmented UTF-8/tool calls, replays reasoning and records usage', async () => {
  const f = fixture(), requests: any[] = [];
  const mock = await listen(async (req, res) => {
    assert.equal(req.url, '/chat/completions');
    const request = await body(req); requests.push(request);
    assert.equal(request.service_tier, 'flex'); assert.equal(request.max_tokens, 16384);
    assert.equal(request.stream_options.include_usage, true);
    assert.equal(request.tools[0].function.name, 'read'); assert.equal(request.input, undefined);
    if (requests.length === 1) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = [
        { choices: [{ index: 0, delta: { content: '检查文件。', reasoning_content: 'reasoning-for-replay', tool_calls: [{ index: 0, id: 'call_read', function: { name: 'read', arguments: '{"path":' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"proof.txt"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], service_tier: 'flex', usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 } } },
      ];
      const bytes = Buffer.from(': heartbeat\r\n\r\n' + chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n');
      for (let offset = 0; offset < bytes.length; offset += 7) res.write(bytes.subarray(offset, offset + 7));
      res.end();
    } else {
      const assistant = request.messages.find((m: any) => m.tool_calls);
      assert.equal(assistant.reasoning_content, 'reasoning-for-replay');
      assert.equal(assistant.tool_calls[0].id, 'call_read');
      assert.ok(request.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_read' && m.content.includes('permission-ok')));
      json(res, { choices: [{ message: { content: '验证成功。' }, finish_reason: 'stop' }], service_tier: 'flex',
        usage: { prompt_tokens: 120, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 96 } } });
    }
  });
  try {
    fs.writeFileSync(path.join(f.workspace, 'proof.txt'), 'permission-ok');
    const store = new Store(f.dataDir), s = store.create(f.workspace);
    const agent = new Agent({ ...f.config, baseUrl: mock.url, apiFormat: 'chat_completions', serviceTier: 'flex', maxOutputTokens: 16384 }, store);
    await agent.start(s, '读取 proof.txt', 'web');
    assert.equal(s.status, 'idle'); assert.equal(requests.length, 2);
    assert.equal(s.messages.at(-1)?.text, '验证成功。');
    assert.deepEqual(s.usage, { input: 220, output: 30, cached: 160, lastServiceTier: 'flex' });
    assert.equal(new Store(f.dataDir).get(s.id).history.find(item => item.role === 'assistant')?.reasoning_content, 'reasoning-for-replay');
  } finally { await mock.close(); f.cleanup(); }
});

test('Chat Completions refuses cut-off tool arguments and redacts authorization errors', async () => {
  const f = fixture(); let count = 0;
  const mock = await listen(async (req, res) => {
    await body(req);
    if (++count === 1) json(res, { choices: [{ message: { tool_calls: [{ id: 'call_incomplete', function: { name: 'write', arguments: '{"path":' } }] }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    else json(res, { error: { message: 'Invalid key: ' + f.config.apiKey } }, 401);
  });
  try {
    const provider = new ResponsesProvider({ ...f.config, apiFormat: 'chat_completions', baseUrl: mock.url });
    await assert.rejects(() => provider.create([], 'test', undefined, new AbortController().signal, () => {}), (error: any) => error.message.includes('length') && error.usage.output_tokens === 5);
    await assert.rejects(() => provider.create([], 'test', undefined, new AbortController().signal, () => {}), (error: any) => error.status === 401 && !error.message.includes(f.config.apiKey));
  } finally { await mock.close(); f.cleanup(); }
});

test('DeepInfra profile persists Flex/protocol, protects credentials and raises queue timeout', async () => {
  const f = fixture();
  try {
    const store = new Store(f.dataDir), profiles = new ProviderProfiles(f.config, store);
    const saved = profiles.save({ label: 'DeepInfra Flex', kind: 'deepinfra', baseUrl: 'https://api.deepinfra.com/v1/openai',
      model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', apiKey: 'test-deepinfra-only', serviceTier: 'flex' });
    assert.equal('apiKey' in saved, false); assert.equal(saved.apiFormat, 'chat_completions');
    const restored = new ProviderProfiles(f.config, store), config = restored.configFor(saved.id);
    assert.equal(config.apiKey, 'test-deepinfra-only'); assert.equal(config.serviceTier, 'flex');
    assert.equal(config.apiFormat, 'chat_completions'); assert.equal(config.cacheMode, 'local');
    assert.equal(config.maxOutputTokens, 32768); assert.ok(config.requestTimeout >= 900000);
    assert.equal(new ProviderProfiles({ ...f.config, maxOutputTokens: 8192 }, store).configFor(saved.id).maxOutputTokens, 8192);
    assert.equal(new ProviderProfiles({ ...f.config, maxOutputTokens: 131072 }, store).configFor(saved.id).maxOutputTokens, 32768);
    const other = restored.save({ label: 'Other DeepInfra model', kind: 'deepinfra', baseUrl: saved.baseUrl, model: 'other-model' });
    assert.equal(restored.configFor(other.id).maxOutputTokens, 16384);
    restored.save({ id: saved.id, label: saved.label, baseUrl: saved.baseUrl, model: saved.model });
    assert.equal(restored.configFor(saved.id).serviceTier, 'flex'); assert.equal(restored.configFor(saved.id).apiKey, 'test-deepinfra-only');
    assert.throws(() => profiles.save({ label: 'Invalid', kind: 'deepinfra', baseUrl: saved.baseUrl, model: saved.model, cacheMode: 'previous_response_id' }), /previous_response_id/);
  } finally { f.cleanup(); }
});

test('length records usage and diagnostics without running truncated tools or retrying; session can resume', async () => {
  const f = fixture(), requests: any[] = [];
  const mock = await listen(async (req, res) => {
    const request = await body(req); requests.push(request);
    if (requests.length === 1) {
      json(res, { choices: [{ message: { tool_calls: [{ id: 'call_completed', function: { name: 'write',
        arguments: JSON.stringify({ path: 'completed.txt', content: 'retained' }) } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 } });
    } else if (requests.length === 2) {
      json(res, { choices: [{ message: { content: '准备生成大文件。', tool_calls: [
        { id: 'call_not_safe', function: { name: 'write', arguments: JSON.stringify({ path: 'never.txt', content: 'do not execute' }) } },
        { id: 'call_truncated', function: { name: 'write', arguments: '{"path":' } },
      ] }, finish_reason: 'length' }], usage: { prompt_tokens: 120, completion_tokens: 32768,
        completion_tokens_details: { reasoning_tokens: 1000 }, estimated_cost: 0.01 } });
    } else {
      assert.ok(request.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_completed'));
      assert.ok(!JSON.stringify(request.messages).includes('call_not_safe'));
      assert.ok(!JSON.stringify(request.messages).includes('call_truncated'));
      json(res, { choices: [{ message: { content: '已继续。' }, finish_reason: 'stop' }] });
    }
  });
  try {
    const store = new Store(f.dataDir), s = store.create(f.workspace);
    const agent = new Agent({ ...f.config, apiFormat: 'chat_completions', baseUrl: mock.url, maxOutputTokens: 32768 }, store);
    await agent.start(s, '生成文件', 'web');
    assert.equal(s.status, 'error'); assert.equal(requests.length, 2);
    assert.match(s.error!, /length.*单次上限 32768 tokens.*本次输出 32768 tokens.*推理 1000 tokens.*工具参数/);
    assert.match(s.error!, /本次响应中的工具调用均未执行/);
    assert.equal(s.usage.input, 220); assert.equal(s.usage.output, 32778);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'completed.txt'), 'utf8'), 'retained');
    assert.equal(fs.existsSync(path.join(f.workspace, 'never.txt')), false);
    assert.equal(s.messages.find(m => m.text === '准备生成大文件。')?.state, 'error');
    const restored = new Store(f.dataDir).get(s.id);
    assert.equal(restored.error, s.error); assert.equal(restored.history.length, 3);
    await agent.start(s, '分段生成大文件，继续', 'web');
    assert.equal(s.status, 'idle'); assert.equal(requests.length, 3); assert.equal(s.messages.at(-1)?.text, '已继续。');
  } finally { await mock.close(); f.cleanup(); }
});
