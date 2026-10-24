import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { ensureService, request } from './service.js';

const config = loadConfig();
const server = new McpServer({ name: 'labor-agent', version: '0.1.0' }, {
  instructions: 'Labor Agent is an autonomous local DeepSeek coding partner. When first connecting for a task, open or reuse the returned local UI URL in the client browser/panel if that capability is available, so the user can observe the work. Reuse an existing tab; never open new tabs on status polling. If the client cannot open a page, show the URL instead. Only AI clients create sessions via session_create; the browser has no creation control. Talk to it using agent_send: explain the goal, scope, constraints and acceptance criteria in ordinary language. It chooses its own tools. Reuse the same session and pass an explicit session_id; use session_select to show the intended session in the UI. While running, agent_send queues new guidance instead of starting another run. Guidance is applied before the next model call; the active tool finishes and unstarted older calls are skipped so it can replan. Do not resubmit the original task when polling. Use agent_cancel to stop the active request/tool immediately. Prefer status and the final deliverable report; inspect relevant recent process records only when needed, starting with the latest task turn. Then verify the outcome. idle means the turn ended, not acceptance passed. The UI shows both sides of this conversation.',
});
const sessionId = z.string().uuid().optional().describe('Session ID. Omit to use the currently selected session.');
const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
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
  description: 'Start or connect to Labor Agent and return its local chat UI URL, model, configuration status and active session. If the client supports opening pages, open or reuse this URL for the user once per collaboration, not on each poll; otherwise show the link. No model API call is made.',
  inputSchema: {}, annotations,
}, () => call(() => request(config, '/api/health')));
server.registerTool('session_create', {
  description: 'Create and select a persistent session. Optionally choose a workspace directory. The UI switches to it immediately.',
  inputSchema: { title: z.string().min(1).max(100).optional(), workspace: z.string().optional() }, annotations,
}, args => call(() => request(config, '/api/sessions', args)));
server.registerTool('session_list', {
  description: 'List saved sessions, their IDs, workspaces, running status and the selected session.',
  inputSchema: {}, annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
}, () => call(() => request(config, '/api/sessions')));
server.registerTool('session_select', {
  description: 'Select an existing session for subsequent instructions and show it in the shared UI.',
  inputSchema: { session_id: z.string().uuid() }, annotations,
}, ({ session_id }) => call(() => request(config, `/api/sessions/${session_id}/select`, {})));
server.registerTool('session_get', {
  description: 'Read a session transcript including user instructions, AI replies, tool calls/results, errors and token usage. Does not change the selected session.',
  inputSchema: { session_id: sessionId, limit: z.number().int().min(1).max(200).default(30) },
  annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
}, ({ session_id, limit }) => call(async () => {
  const s = await request(config, `/api/sessions/${await resolveId(session_id)}`);
  return { ...s, totalMessages: s.messages.length, messages: s.messages.slice(-limit) };
}));
server.registerTool('agent_send', {
  description: 'Talk to the coding agent in ordinary text. When idle, starts a conversational turn (wait_ms default 1s, max 55s). While running, immediately queues the text as guidance for the current task, never starting a parallel run. Guidance takes effect at the next model call after the active tool finishes; unstarted older calls are skipped. pendingGuidance and message.delivery show queued/applied state. The agent chooses tools and may modify files/execute commands. Use agent_status/session_get to monitor; do not repeat the original task. agent_cancel stops immediately.',
  inputSchema: { text: z.string().min(1).max(100000), session_id: sessionId,
    wait_ms: z.number().int().min(0).max(55000).default(1000) },
  annotations: { ...annotations, destructiveHint: true },
}, ({ text, session_id, wait_ms }) => call(async () => {
  const s = await request(config, `/api/sessions/${await resolveId(session_id)}/send`, { text, source: 'mcp', wait_ms });
  return { ...s, totalMessages: s.messages.length, messages: s.messages.slice(-12) };
}));
server.registerTool('agent_status', {
  description: 'Get session status and recent activity. Optionally wait up to 10s before reading. Use to monitor an in-progress instruction without resubmitting it.',
  inputSchema: { session_id: sessionId, wait_ms: z.number().int().min(0).max(10000).default(0) },
  annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
}, ({ session_id, wait_ms }) => call(async () => {
  const id = await resolveId(session_id);
  if (wait_ms) await new Promise(resolve => setTimeout(resolve, wait_ms));
  const s = await request(config, `/api/sessions/${id}`);
  return { id: s.id, title: s.title, status: s.status, error: s.error, usage: s.usage,
    pendingGuidance: s.pendingGuidance, updatedAt: s.updatedAt, messages: s.messages.slice(-4), ui: `http://127.0.0.1:${config.port}` };
}));
server.registerTool('agent_cancel', {
  description: 'Stop the current model request and Bash process tree in a session. Already completed file edits remain in place. Cancellation is asynchronous; check status.',
  inputSchema: { session_id: sessionId }, annotations,
}, ({ session_id }) => call(async () => request(config, `/api/sessions/${await resolveId(session_id)}/cancel`, {})));

// stdout is exclusively MCP JSON-RPC. Backend logs go to .labor-agent/server.log.
await server.connect(new StdioServerTransport());
