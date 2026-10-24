# Labor Agent

[简体中文](README_CN.md) · [Detailed reference (Chinese)](README.md)

Let an execution agent handle implementation while the primary AI plans and verifies. Labor Agent defaults to DeepSeek and offers MCP collaboration with a live chat UI. Its lightweight core is independently implemented, inspired by DeepSeek Harness's minimal interaction style; it does not require the Harness application.

## Why use it

- **Reduce cost:** delegate suitable complex implementation and multi-step commands to a configurable execution model. The primary AI reads final results and essential evidence first, reducing process context and tool rounds on the primary model.
- **Save time:** the execution agent chooses tools, edits files and checks its work. The primary AI can do independent preparation and steer the running task when needed.
- Keep simple edits with the primary AI when delegation would cost more than doing the work directly. Actual cost and time depend on model choice, task size and rework; no fixed savings are guaranteed.

## Features

- Autonomous `read / write / edit / bash`, with tasks and acceptance criteria supplied through ordinary conversation.
- A shared backend for stdio MCP and the browser UI, with persistent sessions and a workspace per session.
- AI-created/selected sessions; the browser supports observation, conversation, steering and cancellation, with no session creation button.
- Mid-task guidance and cancellation of requests and Bash process trees; no fixed 40-model-call limit in the current implementation.
- Responses API, full local history replay and cache-hit reporting; configurable API key, URL and model.
- On first use, the skill and MCP instructions ask browser-capable clients to open or reuse the UI. **The client performs the opening action.** Headless/plain MCP clients receive a URL; polling does not open additional tabs.

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

The default UI is **http://127.0.0.1:3210/**. Use `npm start` for foreground execution, and `npm run restart` after editing `.env`. Management commands: `npm run status` and `npm run stop`. Logs and sessions default to `.labor-agent/`.

On macOS/Linux, replace the copy command with `test -f .env || cp .env.example .env`; the npm commands are the same.

## Install MCP and the skill

For Codex:

```powershell
npm run setup:mcp
npm run setup:skill
```

- `setup:mcp` writes this project's `.codex/config.toml` with absolute paths to Node and `dist/mcp.js`. Reopen/reload the trusted project or client session to load the tools. Other projects need their own project/client configuration.
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

The primary AI defines the goal, architecture, workspace, deliverable paths and acceptance criteria, then dispatches through `agent_send`. It reads the final answer and reports first. When process inspection is needed, it starts with recent records from the latest task turn, expands only as needed, and verifies the actual artifacts. Reuse sessions for related work; create a new one for unrelated tasks.

MCP tools: `agent_start`, `session_create/list/select/get`, and `agent_send/status/cancel`. The AI opens/reuses the UI and selects the intended session; instructions, replies and tool activity appear there.

## Execution boundaries and development

The service listens locally by default. Bash runs with the current user's permissions and **is not a security sandbox**; run trusted tasks only. Do not commit `.env`, credentials or `.labor-agent/` session data. Cancellation does not roll back completed file changes.

```powershell
npm run check
npm test
```

Tests use local mock model services and do not spend real model API credits.
