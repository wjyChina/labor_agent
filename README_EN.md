# Labor Agent

[简体中文](README_CN.md) · [Detailed reference (Chinese)](README.md)

Let an execution agent handle implementation while the primary AI plans and verifies. Labor Agent defaults to DeepSeek and offers MCP collaboration with a live chat UI. Its lightweight core is independently implemented, inspired by DeepSeek Harness's minimal interaction style; it does not require the Harness application.

The browser and MCP share sessions and execution records. The lower-left settings let you switch between DeepSeek API and Codex subscription profiles. The statistics page summarizes token usage, cache-hit rate, output speed and estimated API cost. These screenshots are from the running local UI; session identifiers, project paths and personal usage figures are hidden.

<table>
  <tr>
    <td align="center"><a href="docs/screenshots/workbench.png"><img src="docs/screenshots/workbench.png" width="420" alt="Labor Agent workbench"></a><br>Workbench</td>
    <td align="center"><a href="docs/screenshots/execution-settings.png"><img src="docs/screenshots/execution-settings.png" width="220" alt="Execution settings"></a><br>Execution settings</td>
  </tr>
  <tr>
    <td colspan="2" align="center"><a href="docs/screenshots/token-statistics.png"><img src="docs/screenshots/token-statistics.png" width="640" alt="Token usage statistics"></a><br>Token usage statistics</td>
  </tr>
</table>

## Why use it

- **Reduce cost:** delegate suitable complex implementation and multi-step commands to a configurable execution model. The primary AI reads final results and essential evidence first, reducing process context and tool rounds on the primary model.
- **Save time:** the execution agent chooses tools, edits files and checks its work. The primary AI can do independent preparation and steer the running task when needed.
- Keep simple edits with the primary AI when delegation would cost more than doing the work directly. Actual cost and time depend on model choice, task size and rework; no fixed savings are guaranteed.

## Features

- Autonomous `read / write / edit / bash`, with tasks and acceptance criteria supplied through ordinary conversation.
- A shared backend for stdio MCP and the browser UI, with persistent sessions and a workspace per session.
- Create and select sessions in the browser, choose a project folder, and inspect, steer or cancel execution; MCP can also create and manage sessions.
- Mid-task guidance and cancellation of requests and Bash process trees; no fixed 40-model-call limit in the current implementation.
- Responses API, full local history replay, and per-session cache-hit counts and rates; configurable API key, URL and model.
- Per-session RMB cost estimates for DeepSeek Flash. USD usage is priced at each request's peak/off-peak rate, then converted using a daily updated [USD/CNY mid-market rate](https://frankfurter.dev/); displayed historical RMB amounts change when the rate updates. Cache hits are a subset of input tokens. Chinese public holidays sync from the [Hi8 holiday API](https://hi8.com/t/jiejiari-api) at startup and daily to a local cache; failed updates retain the previous data, and manual holiday marking remains available. Other models and legacy usage without period data are not estimated.
- The service opens the default browser when it starts. AI agents use MCP tools for ordinary collaboration and do not open or operate the UI; users can still inspect and operate the page directly. Headless environments can still use the service through MCP.
- Context management offers the existing handoff mode and optional automatic compression in the same session. Compression defaults to the long strategy; short compresses earlier with denser summaries. Change the global or per-session policy in the monitoring page settings or through the `context_policy` MCP tool. Existing installations retain handoff mode. This applies to API backends; Codex subscription context is managed by Codex CLI.
- Both the page and `context_policy.config` expose `triggerRatio`, `preserveRecentTokens`, `preserveRecentMessages` and `summaryMaxTokens`. Updates are partial and persistent; null resets a field to its strategy default, and `config: null` resets all four. The API returns resolved values, strategy defaults and current model limits. Changes apply at the next model request boundary, including during compression.

Context compression uses an adaptation of [billion-context](https://github.com/ranxianglei/billion-context) / [acp-kernel](https://github.com/ranxianglei/acp-kernel): incremental range summaries, hierarchical distillation, recent verbatim context, and recoverable original archives. No proxy, plugin runtime or unrelated features are installed. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the [configuration details](README.md#上下文和缓存).
- The UI renders common Markdown in user and agent messages, including headings, lists, links, quotes, tables and code blocks; tool output remains plain text.
- The “Execution account and model” control in the lower-left corner selects the global backend: DeepSeek API or a Codex subscription. DeepSeek endpoint, model and API keys can be saved as multiple local profiles; Codex accounts and models are managed there too. New sessions inherit the selected global setting.
- The “+” button creates a session and lets you choose a project folder. The folder is saved as the session workspace; with the Codex global setting it is also passed as the Codex thread `cwd`, so Codex can group it by project.
- The statistics page provides a token-usage heatmap, output-speed chart and cost estimates. Cost is estimated only where the provider returns enough usage data; it is not a final invoice.

## Deployment

Requires **Node.js 22+, npm and Bash**. On Windows, Git Bash is recommended and detected automatically. Other systems default to `/bin/bash`.

Run in the project directory (PowerShell):

```powershell
npm ci
# Preserve any existing .env
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Edit `.env`:

```dotenv
LABOR_API_KEY=your-key
LABOR_BASE_URL=https://api.deepseek.com
LABOR_MODEL=deepseek-flash
LABOR_CACHE_MODE=local
LABOR_PORT=3210
```

Use a URL and model supported by your account or compatible gateway. `local` stores and replays complete history; cache hits are reported by the provider. Use `previous_response_id` only with gateways that support server-side continuation.

```powershell
npm run build
npm run start:bg
```

The default UI is **http://127.0.0.1:3210/**. The service opens the default browser on startup; in headless environments, visit this URL manually. Use `npm start` for foreground execution, and `npm run restart` after editing `.env`. Management commands: `npm run status` and `npm run stop`. Logs and sessions default to `.labor-agent/`.

On macOS/Linux, replace the copy command with `test -f .env || cp .env.example .env`; the npm commands are the same.

## Install MCP and the skill

DeepInfra is available in the lower-left API profile settings: use `https://api.deepinfra.com/v1/openai`, model `deepseek-ai/DeepSeek-V4.1-Flash-1017`, Chat Completions and the Flex tier. Tokens stay in the local data directory. New sessions inherit the active profile. The adapter supports streaming, tool loops, reasoning replay and cached-token usage, with cost estimates supplied by DeepInfra's `estimated_cost`. Flex uses at least a 15-minute request timeout. Flash 1017 accepts requests configured with 32,768 output tokens; the service caps it at the lower of that value and `LABOR_MAX_OUTPUT_TOKENS`, while other DeepInfra models retain a conservative 16,384 cap. Reasoning and tool arguments share the output budget, so large files should be generated in sections. A `length` error reports usage and argument sizes without executing any tools from that response or retrying automatically. Completed operations and history remain available for a follow-up message. The service does not retry on Standard automatically.

For Codex:

```powershell
npm run setup:mcp
npm run setup:skill
```

- `setup:mcp` writes or updates this project's `.codex/config.toml` with absolute paths to Node and `dist/mcp.js`, and sets the MCP tool timeout to 1,860 seconds (30-minute wait plus a 1-minute margin). Reopen/reload the trusted project or client session to load the tools. Other projects need their own project/client configuration.
- `setup:skill` installs into `$CODEX_HOME/skills/labor-agent`, or `~/.codex/skills/labor-agent` when unset. Reopen the session if its skill list has not refreshed. To replace a differing installed version, run `npm run setup:skill -- --update`; this overwrites the installed skill.
- MCP supplies the executable tools; the skill guides planning, delegation and acceptance. The first MCP call can start the backend automatically, so a separate manual start is optional.

Other MCP clients can use the following example with their actual absolute paths. This JSON is not Codex's TOML configuration format:

```json
{
  "mcpServers": {
    "labor_agent": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["D:/codes/labor_agent/dist/mcp.js"]
    }
  }
}
```

## Usage

Once MCP and the skill are loaded, ask:

> Use $labor-agent to fix logout in D:/codes/my-project using its existing architecture. Plan the scope and acceptance criteria before delegating. Preserve styling and verify logout, refresh and protected-route behavior.

The primary AI defines the goal, architecture, workspace, deliverable paths and acceptance criteria, then dispatches through `agent_send`. It reads the final answer and reports first. When process inspection is needed, it starts with recent records from the latest task turn, expands only as needed, and verifies the actual artifacts. Reuse a session for corrections or resuming that unfinished task. After a task or deliverable stage is accepted, create a fresh session for the next stage with a short handoff and artifact paths. MCP and skill instructions guide the coordinator; the service does not detect stages or switch a running session automatically.

Ordinary tool results enter DeepSeek's context as previews of at most 4,000 characters, configurable with `LABOR_TOOL_CONTEXT_CHARS`; captured output remains available in the transcript. Labor can read details through `tool_result_get(result_id, offset, limit)` without rerunning the command. With automatic context compression enabled, consumed history is summarized in place while original records remain available through `context_recall`. Summary requests count toward model usage and metrics. Handoff mode adds no summarization calls.

MCP tools: `agent_start`, `session_create/list/select/get`, and `agent_send/status/wait/cancel`. The AI creates/selects sessions, sends tasks, waits and reads results through MCP; the service opens the UI on startup, where instructions, replies and tool activity are also visible.

`session_get` returns recent messages with short tool-output and argument previews, bounded by a character budget. To inspect a specific result, pass its message `id` in `message_ids` to fetch the full text; increase `max_chars` when `textTruncated` is true. Filter with `roles` or page backward with `before_message_id`. Full tool arguments require `include_tool_args: true`. `agent_send` and `agent_status` also return compact tool previews.

To reduce primary-model polling, omit `wait_ms` from `agent_send` and `agent_wait` to use an adaptive wait based on recent completed-run P80. It prefers up to 100 runs matching the backend, provider and model, then falls back to runs for the same backend; at least five samples are needed, otherwise it waits up to 30 minutes. Each wait is capped at 30 minutes; after the P80 estimate is exceeded, subsequent waits use the full 30 minutes. The service listens for state changes and returns immediately when the run ends, errors or is cancelled, so it does not wait for the entire timeout after completion. Run timing history is stored in `.labor-agent/metrics/agent-runs.jsonl`. Do not send “continue” or “wait” through `agent_send`: while a task is running, that call queues guidance.

## Execution boundaries and development

The service listens locally by default. Bash runs with the current user's permissions and **is not a security sandbox**; run trusted tasks only. Do not commit `.env`, credentials or `.labor-agent/` session data. Cancellation does not roll back completed file changes.

```powershell
npm run check
npm test
```

Tests use local mock model services and do not spend real model API credits.
