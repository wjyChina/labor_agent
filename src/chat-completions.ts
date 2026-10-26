import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { ApiItem } from './store.js';
import { ProviderError, type ModelResponse } from './provider.js';
import { toolDefinitions } from './tools.js';

function textContent(value: any): string {
  if (typeof value === 'string') return value;
  return (value || []).map((part: any) => {
    if (['text', 'input_text', 'output_text'].includes(part.type)) return part.text || '';
    if (part.type === 'refusal') return part.refusal || '';
    throw new ProviderError(`Chat Completions 不支持此内容类型：${part.type}`);
  }).join('\n');
}

// Keep Store's existing Responses-shaped history so file tools, guidance,
// cancellation repairs and tool-result previews share the same implementation.
export function chatMessages(input: ApiItem[], instructions: string): ApiItem[] {
  const messages: ApiItem[] = [{ role: 'system', content: instructions }];
  for (const item of input) {
    if (item.type === 'function_call') {
      let assistant = messages.at(-1)!;
      if (assistant.role !== 'assistant') {
        assistant = { role: 'assistant', content: null }; messages.push(assistant);
      }
      assistant.tool_calls ||= [];
      assistant.tool_calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: String(item.output ?? '') });
    } else if (item.role && ['system', 'user', 'assistant'].includes(item.role)) {
      messages.push({ role: item.role, content: textContent(item.content),
        ...(item.reasoning_content !== undefined ? { reasoning_content: item.reasoning_content } : {}) });
    } else if (item.type !== 'reasoning') {
      throw new ProviderError(`Chat Completions 不支持此历史项：${item.type || 'unknown'}`);
    }
  }
  return messages;
}

export async function createChatCompletion(c: Config, input: ApiItem[], instructions: string,
  signal: AbortSignal, onDelta: (text: string) => void): Promise<ModelResponse> {
  const url = /\/chat\/completions$/.test(c.baseUrl) ? c.baseUrl : `${c.baseUrl}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ model: c.model, messages: chatMessages(input, instructions),
      tools: toolDefinitions.map(({ type, ...fn }) => ({ type, function: fn })), tool_choice: 'auto',
      stream: true, stream_options: { include_usage: true }, max_tokens: c.maxOutputTokens,
      reasoning_effort: c.reasoningEffort, service_tier: c.serviceTier || 'default' }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(c.requestTimeout)]),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 3000).replaceAll(c.apiKey, '[redacted]');
    throw new ProviderError(`模型接口 HTTP ${response.status}：${detail}`, response.status);
  }
  let id: string | undefined, content = '', reasoning = '', finish: string | undefined, rawUsage: any, tier: string | undefined;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const consume = (chunk: any, streaming: boolean) => {
    if (chunk.error) throw new ProviderError(String(chunk.error.message || chunk.error).replaceAll(c.apiKey, '[redacted]'));
    if (chunk.id) id = chunk.id;
    if (chunk.usage) rawUsage = chunk.usage;
    if (chunk.service_tier) tier = chunk.service_tier;
    const choice = chunk.choices?.find((item: any) => item.index === 0 || item.index === undefined);
    if (!choice) return;
    const delta = streaming ? choice.delta || {} : choice.message || {};
    if (delta.content) { content += delta.content; onDelta(delta.content); }
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    for (let index = 0; index < (delta.tool_calls || []).length; index++) {
      const call = delta.tool_calls[index], position = call.index ?? index;
      const value = calls.get(position) || { id: '', name: '', arguments: '' };
      if (call.id) value.id = call.id;
      value.name += call.function?.name || ''; value.arguments += call.function?.arguments || '';
      calls.set(position, value);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };
  if (response.headers.get('content-type')?.includes('application/json')) consume(await response.json(), false);
  else {
    if (!response.body) throw new ProviderError('模型返回了空的流。');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', doneEvent = false;
    const event = (block: string) => {
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data === '[DONE]') { doneEvent = true; return; }
      consume(JSON.parse(data), true);
    };
    try {
      while (!doneEvent) {
        const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
        let delimiter: RegExpExecArray | null;
        while ((delimiter = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, delimiter.index).replace(/\r\n/g, '\n');
          buffer = buffer.slice(delimiter.index + delimiter[0].length); event(block);
        }
        if (buffer.length > 16_000_000) throw new ProviderError('模型 SSE 事件过大。');
        if (done) { if (buffer.trim()) event(buffer.replace(/\r\n/g, '\n')); break; }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  const usage = rawUsage ? {
    input_tokens: rawUsage.prompt_tokens || 0, output_tokens: rawUsage.completion_tokens || 0,
    input_tokens_details: { cached_tokens: rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0 },
    ...(rawUsage.completion_tokens_details ? { output_tokens_details: rawUsage.completion_tokens_details } : {}),
    ...(typeof rawUsage.estimated_cost === 'number' ? { estimated_cost: rawUsage.estimated_cost } : {}),
  } : undefined;
  if (!finish) throw new ProviderError('模型流提前断开，没有收到完成标记。', 502, usage);
  if (finish === 'length') {
    const details = [`配置单次上限 ${c.maxOutputTokens} tokens`];
    if (typeof rawUsage?.completion_tokens === 'number') details.push(`本次输出 ${rawUsage.completion_tokens} tokens`);
    const reasoningTokens = rawUsage?.completion_tokens_details?.reasoning_tokens;
    if (typeof reasoningTokens === 'number') details.push(`其中推理 ${reasoningTokens} tokens`);
    const argumentChars = [...calls.values()].reduce((total, call) => total + call.arguments.length, 0);
    details.push(`正文 ${content.length} 字符`, `工具参数 ${argumentChars} 字符`);
    throw new ProviderError(`模型输出被截断（length；${details.join('，')}）。` +
      (calls.size ? '本次响应中的工具调用均未执行。' : '') +
      '推理、正文和工具参数共享输出预算。请将大文件分段生成，或在配置中调低推理强度后继续。', 502, usage);
  }
  if (!['stop', 'tool_calls'].includes(finish)) throw new ProviderError(`模型未完成：${finish}`, 502, usage);
  const output: ApiItem[] = [];
  if (content || reasoning) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }],
    ...(reasoning ? { reasoning_content: reasoning } : {}) });
  for (const [, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
    if (!call.id || !call.name) throw new ProviderError('模型返回了不完整的工具调用。', 502, usage);
    output.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments || '{}' });
  }
  if (finish === 'tool_calls' && !calls.size) throw new ProviderError('模型工具调用缺失。', 502, usage);
  return { id: id || randomUUID(), status: 'completed', output, usage, service_tier: tier };
}
