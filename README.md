# Labor Agent

[简明中文指南](README_CN.md) · [English guide](README_EN.md)

一个简易的本地编程 Agent。默认使用 **DeepSeek + Responses API**，自主选择 `read / write / edit / bash`，可通过 **stdio MCP** 对话协作，也可直接在浏览器里对话。MCP 与界面共享同一个后台和会话；从 MCP 发来的消息显示为「协作助手」，回复和执行记录实时可见。界面无需选择工具，只需描述任务、要求和验收标准。

使用独立的轻量工具循环内核；参考 DeepSeek Harness 极简交互，不依赖、复制或修改已安装的 Harness 私有运行时。

## 快速启动

需要 Node.js 22 或更新版本。Windows 需要 Git Bash（本机会自动检测 `C:/Program Files/Git/bin/bash.exe`）。

```powershell
cd D:\codes\labor_agent
npm install
Copy-Item .env.example .env   # 已有 .env 时跳过，避免覆盖
```

编辑项目根目录的 `.env`：

```dotenv
LABOR_API_KEY=你的DeepSeek密钥
LABOR_BASE_URL=https://api.deepseek.com
LABOR_MODEL=deepseek-flash
LABOR_CACHE_MODE=local
```

```powershell
npm run build
npm start
```

打开 <http://127.0.0.1:3210>。也可以运行 `./start.ps1` 自动准备依赖并启动。界面只显示会话列表、对话和输入框，可以选择已有会话、发送消息、在执行中引导或停止。**新会话仅由 AI 通过 MCP 的 `session_create` 建立**，网页不提供新建入口，也不会首次发送时自动创建。每个会话可由 AI 指定独立工作目录。

后台运行和管理：

```powershell
npm run start:bg
npm run status
npm run restart  # 修改 .env 后运行；先停止旧服务，再编译并启动
npm run stop
```

`npm start` 是前台运行，按 Ctrl+C 退出。MCP 自动启动的后台独立于 MCP 客户端生命周期；用 `npm run stop` 关闭。后台日志位于 `.labor-agent/server.log`。若修改了 `LABOR_DATA_DIR`，请先关闭旧服务。

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LABOR_API_KEY` | 空 | DeepSeek API Key；也接受 `DEEPSEEK_API_KEY` |
| `LABOR_BASE_URL` | `https://api.deepseek.com` | API 基址；也接受 `DEEPSEEK_BASE_URL`。会追加 `/responses`，也可直接填写完整 `/responses` 地址 |
| `LABOR_MODEL` | `deepseek-flash` | 模型名；可改为账号/网关支持的其他模型，例如 `deepseek-v4-pro` |
| `LABOR_CACHE_MODE` | `local` | `local` 或 `previous_response_id` |
| `LABOR_REASONING_EFFORT` | `high` | `none / low / high / max` |
| `LABOR_WORKSPACE` | `.` | 新会话默认工作目录 |
| `LABOR_DATA_DIR` | `.labor-agent` | 会话文件、当前选择、服务锁及日志 |
| `LABOR_PORT` | `3210` | 本地网页 / 内部 HTTP API 端口 |
| `LABOR_BASH_PATH` | 自动检测 | Bash 可执行文件路径 |
| `LABOR_MAX_OUTPUT_TOKENS` | `32768` | 每次模型响应的输出上限（包含推理） |
| `LABOR_REQUEST_TIMEOUT_MS` | `180000` | 单次 API 请求超时，毫秒 |

`.env` 从本项目根目录读取，与 MCP 客户端当前目录无关。相对路径也以本项目根目录解析；创建会话时提供的相对目录以默认工作目录解析。进程环境变量优先于 `.env`。修改 API、模型或端口需要重启服务；修改端口或数据目录后还需要重新加载 MCP 客户端。不会自动读取 Harness 的密钥。

## 在 Codex 中使用 MCP

```powershell
npm run build
npm run setup:mcp
```

会生成当前项目的 `.codex/config.toml`，使用本机 Node 的绝对路径运行 `dist/mcp.js`。在 Codex 中重新打开此项目或重启会话以加载 MCP。项目配置需要项目已受信任；参见 [Codex 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)。当前已运行的聊天不会因为文件写入就自动获得新工具。

其他 MCP 客户端可使用（将路径改成本机实际路径）：

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

| MCP 工具 | 用途 |
| --- | --- |
| `agent_start` | 启动/连接后台，返回界面地址、模型、配置状态 |
| `session_create` | 创建并选择会话，可传 `title`、`workspace` |
| `session_list` | 列出会话和当前选择 |
| `session_select` | 用 `session_id` 切换当前会话，界面同步切换 |
| `session_get` | 读取对话和工具记录；工具结果默认只给摘要，可按角色过滤、向前分页，或按消息 ID 读取完整内容 |
| `agent_send` | 传 `text` 对话；空闲时启动一轮，执行中自动作为引导。可传 `session_id`、`wait_ms`（0–55000，默认 1000；引导立即确认） |
| `agent_status` | 立即查询执行状态和最近记录；可选 `wait_ms` |
| `agent_wait` | 等待会话结束或超时；状态变化时提前返回，最长 55 秒 |
| `agent_cancel` | 中止指定/当前会话的请求与 Bash 进程树 |

典型调用顺序：

```text
agent_start {}
session_create {"title":"项目巡检","workspace":"D:/codes/your-project"}
agent_send {"text":"读取项目说明并检查启动方式。","wait_ms":55000}
agent_wait {"wait_ms":55000}
session_get {"limit":30}
```

`session_get` 默认返回最近 30 条消息；工具结果与工具参数仅提供短预览，并受总字符预算限制。需要核对某条结果时，把返回的消息 `id` 传入 `message_ids`，即可读取指定消息的完整文本；若返回 `textTruncated: true`，可增大 `max_chars`。`roles` 用于筛选 `user`、`assistant`、`tool`、`system`，`before_message_id` 用于向前分页。读取完整工具参数需显式设置 `include_tool_args: true`。

为减少主 AI 的轮询开销，长任务派发时可给 `agent_send` 设置 `wait_ms: 55000`；若仍在运行，使用 `agent_wait(wait_ms: 55000)`。等待工具会监听会话状态变化，结束、报错或取消时立即返回，超时仍运行时才返回。不要用 `agent_send` 发送“继续/等待”来轮询，因为运行中的发送会成为任务引导。

工具未传 `session_id` 时使用当前选中的会话。长任务返回 `running` 后会继续执行，通过 `agent_wait` 等它结束；`agent_status` 用于立即查看状态。不要为了轮询重复 `agent_send`，运行中再次发送的文本会成为当前任务的引导。空闲时发送才启动新一轮。同一会话同时只运行一轮，不同会话可独立运行。读写同一个工作目录时，应避免给不同会话下发冲突的任务。

### 执行中的引导

任务运行时输入框保持可用，按钮显示“引导”。直接补充要求，例如“先不要改页面样式，完成当前步骤后只检查退出流程”。MCP 也通过同一个 `agent_send` 发送，不需要选择模式。

- 消息立即保存并标为“引导 · 待应用”，`pendingGuidance` 返回待应用条数。
- 当前 API 响应或工具执行结束后，后台跳过尚未开始的旧工具调用，在下一次模型调用前按顺序加入引导，让 Agent 重新安排。
- 纳入上下文后标为“引导 · 已纳入上下文”；这表示已加入请求历史，不代表要求已经实现或验收通过。
- 引导不会即时打断当前 Bash，也不会回滚已完成的修改。需要立即中断时使用“停止”/`agent_cancel`。
- 停止、报错或重启后未应用的引导仍保留，继续对话时处理。当前没有固定40次模型调用上限；任务会持续到完成、取消或发生错误。

## 用对话派发与验收（配套 skill）

项目中提供 [labor-agent skill](skills/labor-agent/SKILL.md)，用于让 Codex 通过 MCP 与 Labor Agent 协作。安装到本机 Codex skills 目录：

```powershell
npm run setup:skill
```

默认安装到 `~/.codex/skills/labor-agent`，设置了 `CODEX_HOME` 时使用它的 `skills` 子目录。源文件保存在本项目 `skills/labor-agent`。已有不同版本时不会直接覆盖，可在确认更新后运行 `npm run setup:skill -- --update`。重新打开会话刷新技能列表后，可直接说：

```text
使用 $labor-agent，让 Labor Agent 完成这个项目的登录退出修复。
验收标准是：退出后返回登录页、刷新后仍未登录、受保护页面不可直接访问。
你检查它的产物和证据，未通过就继续在同一会话反馈修正。
```

协作过程：Codex 用 `agent_send.text` 说清目标、范围、验收标准；Labor Agent 自主选择工具并执行，回复逐条验证结果和证据；Codex 读取记录并核验真实文件与必要行为，再用普通对话追问或反馈修改。没有额外的工具选择、任务类型表单或强制 JSON 任务协议。

验收标准保存在对话上下文中，后续可明确变更；未执行的检查需标记为未验证。`idle` 只表示本轮结束，不能直接当成验收通过。协作时应保存并显式传 `session_id`，避免网页切换会话后任务被发到其他会话。

## 上下文和缓存

- **DeepSeek 默认 `local`**：每轮将完整的 Responses input/output（包括 reasoning、工具调用和结果）持久保存，后续请求完整续传。重启后台后可以继续旧会话。
- **服务端前缀缓存**由 DeepSeek 自动管理；界面按接口返回的用量显示每个 session 的缓存命中量和命中率（缓存命中输入 token ÷ 输入 token）。保存历史不代表每轮免计费。
- 网页按 session 展示 DeepSeek Flash 的 USD 费用估算，按每次请求的峰谷时段统计输入、缓存命中和输出 token；缓存命中属于输入 token 的子集。升级前缺少分时记录的历史用量及其他模型不计入估算，法定节假日需在网页手动勾选。估算使用[DeepSeek 官方价格](https://api-docs.deepseek.com/quick_start/pricing/)，实际账单以服务商为准。
- **`previous_response_id`**：仅供支持服务端上下文的网关；仅发送新增项，并继续发送系统指令。服务端明确报告 ID 失效时，回退到本地完整历史；更换模型、地址或密钥时重置 ID。
- DeepSeek 官方当前**不支持** `previous_response_id`、`conversation` 和 `store`，因此连接官方接口时应保留 `local`。[DeepSeek Responses 兼容说明](https://api-docs.deepseek.com/guides/responses_api/)。ID 续接语义参见 [OpenAI 会话状态说明](https://developers.openai.com/api/docs/guides/conversation-state)。
- 暂不做自动压缩或总结，超出模型上下文窗口时会显示接口错误，需要新建会话。请求失败和停止执行都会保留已完成的记录与文件修改。

## 工具行为与运行范围

- `read`：读取 UTF-8 文件或列目录，可按行分页，有输出大小上限。
- `write`：创建文件和父目录，覆盖已有文件必须显式传 `overwrite=true`。
- `edit`：精确文本替换；多处匹配默认报错，可传 `replace_all=true`；保留 CRLF/LF 和已有文件权限。
- `bash`：真实 Bash，默认 60 秒，最多 300 秒；捕获 stdout、stderr、退出码，限制输出；停止时结束命令进程树。

文件工具限制在当前会话工作目录内，拒绝路径穿越、目录外的符号链接、`.env` 和 agent 内部数据。Bash 使用当前用户的系统权限，**不是安全沙箱**，可访问工作目录之外；启动子进程时去掉继承的 API Key、Token、Secret 等环境变量，但这不阻止命令读取磁盘文件。会话与工具结果以明文保存在本机，只应给可信客户端和指令使用。

服务只绑定 `127.0.0.1`，校验 Host/Origin，不启用跨域；写接口只接受 JSON，模型输出按文本安全渲染。创建会话的内部 HTTP 接口需要 MCP 适配器持有的本地令牌（`.labor-agent/mcp-token`），网页不持有该令牌。该限制用于区分产品入口，不是 OS 沙箱，也不阻止有本机文件访问权限的人使用 MCP 客户端。API Key 不下发浏览器，不写进会话元数据。没有远程访问、用户登录或按命令审批流程。

## 开发与验证

```powershell
npm run dev       # 后端自动重载；修改前端后刷新浏览器
npm run check
npm test          # 先编译，再执行测试
```

测试使用本地模拟 Responses 服务，不消耗真实 API：覆盖四个工具的连续调用、多轮历史续传、ID 续接与失效回退、UTF-8 SSE 流、HTTP 错误和截断流、停止 Bash、崩溃恢复、路径边界，以及真实 stdio MCP → 后台 → HTTP 界面的共享会话链路。还验证了执行中引导的顺序、两种缓存模式下的续传、跳过未开始的调用、保留当前工具结果、最终回复期间的引导、停止后恢复，以及网页不能创建会话。真实 DeepSeek 连通性需要配置有效密钥后验证。

```text
src/config.ts    .env 与默认配置
src/store.ts     原子写入、会话持久化与恢复
src/provider.ts  Responses API 与 SSE 解码
src/tools.ts     read / write / edit / bash
src/agent.ts     工具调用循环与取消
src/server.ts    共享后台、HTTP API、界面事件流
src/mcp.ts       stdio MCP 适配器
src/service.ts   后台发现与自动启动
public/         无构建步骤的聊天界面
skills/         对话派发、核验与反馈的配套 skill
tests/          工具、模型协议、会话与 MCP 集成测试
```

MCP 使用 [官方 TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server) 的 stdio 传输。依赖锁定在 `package-lock.json`，建议后续安装使用 `npm ci`。
