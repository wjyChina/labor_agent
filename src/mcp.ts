import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { ensureService, request } from './service.js';
import type { Message } from './store.js';

const config = loadConfig();
const server = new McpServer({ name: 'labor-agent', version: '0.1.0' }, {
  instructions: 'Labor Agent is an autonomous local DeepSeek coding partner. Use MCP tools for all ordinary task interaction; do not open or operate the local browser UI to send tasks, select sessions, poll status, or read transcripts. The backend opens the UI when the service starts. Create sessions with session_create, then pass an explicit session_id to MCP calls. Talk to it using agent_send: explain the goal, scope, constraints and acceptance criteria in ordinary language. It chooses its own tools. For long tasks, set agent_send wait_ms to 55000. If it returns running, call agent_wait with wait_ms up to 55000; if that times out while still running, keep waiting. Do not do unrelated preparation or repeatedly read the transcript while waiting. While running, agent_send queues new guidance instead of starting another run; only send it to correct direction or resolve a blocker, never as a wait command. Guidance is applied before the next model call; the active tool finishes and unstarted older calls are skipped so it can replan. Do not resubmit the original task when polling. Use agent_cancel to stop the active request/tool immediately. Prefer status and the final deliverable report; inspect recent process records only when needed, starting with the latest task turn. session_get returns compact tool-result previews by default; when a specific result is needed, call it again with that message ID in message_ids to fetch full text, and increase max_chars if it is truncated. Use before_message_id to page backwards and roles to filter. Then verify the outcome. idle means the turn ended, not acceptance passed. Only use browser tools when the user explicitly asks you to inspect or operate the UI.',
});
const sessionId = z.string().uuid().optional().describe('Session ID. Omit to use the currently selected session.');
const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const messageRoles = z.enum(['user', 'assistant', 'tool', 'system']);
const messageId = z.string().uuid();
const defaultToolPreview = 500;
const argsPreview = 250;

function jsonText(value: unknown) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? ''; } catch { return String(value); }
}

function formatMessages(messages: Message[], options: {
  full: boolean; includeToolArgs?: boolean; maxChars: number; toolPreviewChars?: number;
}) {
  let remaining = options.maxChars;
  const formatted: Record<string, unknown>[] = [];
  const omittedMessageIds: string[] = [];
  const truncatedMessageIds: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const isTool = message.role === 'tool';
    const fullText = message.text || '';
    const desiredTextLength = options.full || !isTool
      ? fullText.length
      : Math.min(fullText.length, options.toolPreviewChars ?? defaultToolPreview);
    const textLength = Math.min(desiredTextLength, remaining);
    const text = fullText.slice(0, textLength);
    remaining -= textLength;
    const entry: Record<string, unknown> = {
      id: message.id, role: message.role, time: message.time,
      text, textLength: fullText.length, textTruncated: textLength < fullText.length,
    };
    if (message.source) entry.source = message.source;
    if (message.tool) entry.tool = message.tool;
    if (message.state) entry.state = message.state;
    if (message.kind) entry.kind = message.kind;
    if (message.delivery) entry.delivery = message.delivery;
    if (isTool && message.args !== undefined) {
      const serializedArgs = jsonText(message.args);
      const includeFullArgs = options.full && options.includeToolArgs;
      if (includeFullArgs && serializedArgs.length <= remaining) {
        entry.args = message.args;
        remaining -= serializedArgs.length;
      } else {
        const shownArgs = serializedArgs.slice(0, Math.min(argsPreview, remaining));
        entry.argsPreview = shownArgs;
        entry.argsLength = serializedArgs.length;
        entry.argsTruncated = shownArgs.length < serializedArgs.length;
        remaining -= shownArgs.length;
      }
    }
    if (textLength < fullText.length || (isTool && message.args !== undefined && entry.argsTruncated))
      truncatedMessageIds.push(message.id);
    formatted.push(entry);
    if (remaining === 0 && i > 0) {
      omittedMessageIds.push(...messages.slice(0, i).map(m => m.id));
      break;
    }
  }
  formatted.reverse();
  truncatedMessageIds.reverse();
  return { messages: formatted, omittedMessageIds, truncatedMessageIds };
}

function sessionMetadata(s: any) {
  return {
    id: s.id, title: s.title, workspace: s.workspace, createdAt: s.createdAt,
    updatedAt: s.updatedAt, status: s.status, error: s.error, usage: s.usage,
    historyItems: s.historyItems, pendingGuidance: s.pendingGuidance,
  };
}
async function sessionStatus(id: string, waitMs = 0) {
  const s = waitMs > 0
    ? await request(config, `/api/sessions/${id}/wait?wait_ms=${waitMs}`)
    : await request(config, `/api/sessions/${id}`);
  const formatted = formatMessages(s.messages.slice(-4), { full: false, maxChars: 3_000, toolPreviewChars: 250 });
  return {
    ...sessionMetadata(s), messages: formatted.messages,
    ...(s.waitResult ? { waitResult: s.waitResult, waitedMs: s.waitedMs } : {}),
  };
}
async function call(action: () => Promise<unknown>) {
  try {
    await ensureService(config); const data = await action();
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
  }
}
async function resolveId(id?: string) {
  if (id) return id;
  const state = await request(config, '/api/sessions');
  if (!state.activeSessionId) throw new Error('请先调用 session_create 或 session_select。');
  return state.activeSessionId;
}
server.registerTool('agent_start', {
  description: 'Start or connect to Labor Agent and return service status, model, configuration status and active session. The backend opens its UI when the service starts; use MCP tools for interaction. No model API call is made.',
  inputSchema: {}, annotations,
}, () => call(async () => {
  const { url: _uiUrl, ...status } = await request(config, '/api/health');
  return status;
}));
server.registerTool('session_create', {
  description: 'Create and select a persistent session. Optionally choose a workspace directory. Pass its returned session_id to subsequent MCP calls.',
  inputSchema: { title: z.string().min(1).max(100).optional(), workspace: z.string().optional() }, annotations,
}, args => call(() => request(config, '/api/sessions', args)));
server.registerTool('session_list', {
  description: 'List saved sessions, their IDs, workspaces, running status and the selected session.',
  inputSchema: {}, annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
}, () => call(() => request(config, '/api/sessions')));
server.registerTool('session_select', {
  description: 'Select an existing session as the default for subsequent MCP calls. Ordinary task interactions should pass session_id explicitly.',
  inputSchema: { session_id: z.string().uuid() }, annotations,
}, ({ session_id }) => call(() => request(config, `/api/sessions/${session_id}/select`, {})));
server.registerTool('session_get', {
  description: 'Read session messages with compact tool-result previews by default. Filter by roles and page backwards with before_message_id. To fetch complete message text, pass one or more message_ids; increase max_chars if textTruncated is true. Full tool arguments require include_tool_args=true. Does not change the selected session.',
  inputSchema: {
    session_id: sessionId,
    limit: z.number().int().min(1).max(200).default(30),
    roles: z.array(messageRoles).min(1).max(4).optional().describe('Only include these message roles; defaults to all roles.'),
    before_message_id: messageId.optional().describe('Return messages older than this message ID.'),
    message_ids: z.array(messageId).min(1).max(50).optional().describe('Fetch selected messages with full text, bypassing limit and roles. Use IDs returned by an earlier session_get call.'),
    include_tool_args: z.boolean().default(false).describe('When fetching selected messages, include full tool arguments if they fit within max_chars.'),
    max_chars: z.number().int().min(1_000).max(100_000).optional().describe('Aggregate character budget for message text and tool arguments. Defaults to 12,000 for transcript reads and 30,000 for selected-message reads.'),
  },
  annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
}, ({ session_id, limit, roles, before_message_id, message_ids, include_tool_args, max_chars }) => call(async () => {
  const s = await request(config, `/api/sessions/${await resolveId(session_id)}`);
  if (message_ids?.length && before_message_id) throw new Error('message_ids 和 before_message_id 不能同时使用。');
  let candidates: Message[];
  let hasOlder = false;
  let missingMessageIds: string[] = [];
  if (message_ids?.length) {
    const wanted = new Set(message_ids);
    candidates = s.messages.filter((message: Message) => wanted.has(message.id));
    const found = new Set(candidates.map(message => message.id));
    missingMessageIds = message_ids.filter(id => !found.has(id));
  } else {
    let eligible: Message[] = s.messages;
    if (before_message_id) {
      const cursor = s.messages.findIndex((message: Message) => message.id === before_message_id);
      if (cursor < 0) throw new Error(`找不到分页游标消息：${before_message_id}`);
      eligible = s.messages.slice(0, cursor);
    }
    if (roles?.length) {
      const selectedRoles = new Set(roles);
      eligible = eligible.filter((message: Message) => selectedRoles.has(message.role));
    }
    candidates = eligible.slice(-limit);
    hasOlder = eligible.length > candidates.length;
  }
  const detailed = Boolean(message_ids?.length);
  const formatted = formatMessages(candidates, {
    full: detailed, includeToolArgs: include_tool_args,
    maxChars: max_chars ?? (detailed ? 30_000 : 12_000),
  });
  const hasMore = !detailed && (hasOlder || formatted.omittedMessageIds.length > 0);
  return {
    ...sessionMetadata(s), totalMessages: s.messages.length,
    returnedMessages: formatted.messages.length,
    hasMore,
    ...(hasMore && formatted.messages.length ? { nextBeforeMessageId: formatted.messages[0].id } : {}),
    ...(missingMessageIds.length ? { missingMessageIds } : {}),
    ...(formatted.omittedMessageIds.length ? { omittedMessageIds: formatted.omittedMessageIds } : {}),
    ...(formatted.truncatedMessageIds.length ? { truncatedMessageIds: formatted.truncatedMessageIds } : {}),
    messages: formatted.messages,
  };
}));
server.registerTool('agent_send', {
  description: 'Talk to the coding agent in ordinary text. When idle, starts a conversational turn (wait_ms default 1s, max 55s). While running, immediately queues the text as guidance for the current task, never starting a parallel run. Guidance takes effect at the next model call after the active tool finishes; unstarted older calls are skipped. pendingGuidance and message.delivery show queued/applied state. The agent chooses tools and may modify files/execute commands. Recent tool results in this response are previews; use session_get with a returned message ID in message_ids to fetch a full result. Use agent_wait to wait for completion, agent_status for an immediate snapshot, and do not repeat the original task. agent_cancel stops immediately.',
  inputSchema: { text: z.string().min(1).max(100000), session_id: sessionId,
    wait_ms: z.number().int().min(0).max(55000).default(1000) },
  annotations: { ...annotations, destructiveHint: true },
}, ({ text, session_id, wait_ms }) => call(async () => {
  const s = await request(config, `/api/sessions/${await resolveId(session_id)}/send`, { text, source: 'mcp', wait_ms });
  const formatted = formatMessages(s.messages.slice(-12), { full: false, maxChars: 6_000, toolPreviewChars: 350 });
  return { ...sessionMetadata(s), totalMessages: s.messages.length, messages: formatted.messages,
    ...(formatted.omittedMessageIds.length ? { omittedMessageIds: formatted.omittedMessageIds } : {}),
    ...(formatted.truncatedMessageIds.length ? { truncatedMessageIds: formatted.truncatedMessageIds } : {}) };
}));
server.registerTool('agent_status', {
  description: 'Get a session status snapshot with compact tool-result previews. By default this returns immediately; if wait_ms is positive, it returns when the run ends or that wait expires. Prefer agent_wait for blocking waits. Use session_get with a returned message ID in message_ids to fetch a full result.',
  inputSchema: { session_id: sessionId, wait_ms: z.number().int().min(0).max(55000).default(0) },
  annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
}, ({ session_id, wait_ms }) => call(async () => {
  const id = await resolveId(session_id);
  return sessionStatus(id, wait_ms);
}));
server.registerTool('agent_wait', {
  description: 'Wait for a running Labor Agent session to reach idle, error or cancelled, returning immediately on the state change. A timeout returns the current running status. Prefer this to repeated agent_status polling; it does not send guidance to the running task.',
  inputSchema: { session_id: sessionId, wait_ms: z.number().int().min(1).max(55000).default(55000) },
  annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
}, ({ session_id, wait_ms }) => call(async () => {
  const id = await resolveId(session_id);
  return sessionStatus(id, wait_ms);
}));
server.registerTool('agent_cancel', {
  description: 'Stop the current model request and Bash process tree in a session. Already completed file edits remain in place. Cancellation is asynchronous; check status.',
  inputSchema: { session_id: sessionId }, annotations,
}, ({ session_id }) => call(async () => request(config, `/api/sessions/${await resolveId(session_id)}/cancel`, {})));

// stdout is exclusively MCP JSON-RPC. Backend logs go to .labor-agent/server.log.
await server.connect(new StdioServerTransport());
