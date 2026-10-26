import type { Config } from './config.js';
import type { ApiItem } from './store.js';
import { toolDefinitions } from './tools.js';
import { createChatCompletion } from './chat-completions.js';

export type ModelResponse = { id?: string; status?: string; output: ApiItem[]; usage?: any; error?: any; incomplete_details?: any; service_tier?: string };
// No tokenizer is bundled because gateways may use different model tokenizers.
// This deliberately conservative estimate is used only before a request; the
// provider's input_tokens value is recorded after each successful response.
export function estimateRequestTokens(input: ApiItem[], instructions: string, reservedOutputTokens: number) {
  const payload = JSON.stringify({ instructions, input, tools: toolDefinitions });
  let ascii = 0, nonAscii = 0;
  for (const char of payload) (char.codePointAt(0)! <= 0x7f ? ascii++ : nonAscii++);
  const estimatedInputTokens = Math.ceil(ascii / 3 + nonAscii / 1.5);
  return { estimatedInputTokens, estimatedRequestTokens: estimatedInputTokens + Math.max(0, reservedOutputTokens) };
}
export class ProviderError extends Error {
  constructor(message: string, public status = 502, public usage?: any) { super(message); }
}
export class ResponsesProvider {
  constructor(private config: Config) {}
  async create(input: ApiItem[], instructions: string, previousId: string | undefined,
    signal: AbortSignal, onDelta: (text: string) => void): Promise<ModelResponse> {
    const c = this.config;
    if (!c.apiKey) throw new ProviderError('尚未配置 API Key。请在左下角设置中填写。', 400);
    if (c.apiFormat === 'chat_completions') return createChatCompletion(c, input, instructions, signal, onDelta);
    const body = { model: c.model, instructions, input, tools: toolDefinitions, tool_choice: 'auto',
      stream: true, max_output_tokens: c.maxOutputTokens, reasoning: { effort: c.reasoningEffort },
      ...(c.cacheMode === 'previous_response_id' ? { store: true, ...(previousId ? { previous_response_id: previousId } : {}) } : {}),
    };
    const url = /\/responses$/.test(c.baseUrl) ? c.baseUrl : `${c.baseUrl}/responses`;
    const response = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(c.requestTimeout)]),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 3000).replaceAll(c.apiKey, '[redacted]');
      throw new ProviderError(`模型接口 HTTP ${response.status}：${text}`, response.status);
    }
    let final: ModelResponse | undefined;
    if (response.headers.get('content-type')?.includes('application/json')) {
      final = await response.json() as ModelResponse;
      for (const item of final.output || []) if (item.type === 'message')
        for (const part of item.content || []) if (part.type === 'output_text') onDelta(part.text);
    } else {
      if (!response.body) throw new ProviderError('模型返回了空的流。');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      const event = (block: string) => {
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') return;
        const e = JSON.parse(data);
        if (e.type === 'response.output_text.delta') onDelta(e.delta || '');
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(e.type)) final = e.response;
        if (e.type === 'error') throw new ProviderError(e.message || e.error?.message || '模型流错误。');
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          // Normalize CRLF only after the complete delimiter is received.
          let match: RegExpExecArray | null;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const block = buffer.slice(0, match.index).replace(/\r\n/g, '\n');
            buffer = buffer.slice(match.index + match[0].length); event(block);
          }
          if (buffer.length > 16_000_000) throw new ProviderError('模型 SSE 事件过大。');
          if (done) { if (buffer.trim()) event(buffer.replace(/\r\n/g, '\n')); break; }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    if (!final || !Array.isArray(final.output)) throw new ProviderError('模型流提前断开，没有收到完整 response。请重试。');
    if (final.status && final.status !== 'completed')
      throw new ProviderError(`模型未完成：${final.error?.message || final.incomplete_details?.reason || final.status}`, 502, final.usage);
    return final;
  }
}
