# Labor Agent

[English](README_EN.md) · [详细说明](README.md)

把具体实现交给执行 Agent，把规划和验收留给主 AI。Labor Agent 默认连接 DeepSeek，支持 MCP 协作和实时网页对话；采用独立轻量内核，参考 DeepSeek Harness 极简交互，不依赖其安装程序。

网页与 MCP 共用会话和执行记录。左下角可切换 DeepSeek API 或 Codex 订阅配置；统计页可查看 Token 消耗、缓存命中率、输出速度和费用估算。以下是实际运行界面截图，会话标识、项目路径及个人用量数字已遮盖。

<table>
  <tr>
    <td align="center"><a href="docs/screenshots/workbench.png"><img src="docs/screenshots/workbench.png" width="420" alt="Labor Agent 工作台"></a><br>工作台</td>
    <td align="center"><a href="docs/screenshots/execution-settings.png"><img src="docs/screenshots/execution-settings.png" width="220" alt="执行配置"></a><br>执行配置</td>
  </tr>
  <tr>
    <td colspan="2" align="center"><a href="docs/screenshots/token-statistics.png"><img src="docs/screenshots/token-statistics.png" width="640" alt="Token 使用统计"></a><br>Token 使用统计</td>
  </tr>
</table>

## 为什么用它

- **省钱**：将适合的复杂代码实现和多步骤命令交给可配置的执行模型，主 AI 默认只看最终结果和必要证据，减少主模型的过程上下文与执行轮次。
- **省时**：执行 Agent 自主选工具、修改文件并自检；主 AI 可以同时做其他准备，发现偏差后在执行中补充“引导”。
- 简单改动仍由主 AI 直接完成，避免委派成本超过任务本身。实际费用和耗时取决于模型、任务和返工，不承诺固定节省比例。

## 主要功能

- 自主使用 `read / write / edit / bash`，通过普通对话接收任务和验收标准。
- stdio MCP 与网页共享后台、持久会话和执行记录；每个会话可指定工作目录。
- 网页可新建、选择和查看会话，选择项目文件夹，并在执行中对话、引导或停止；MCP 也可创建和管理会话。
- 支持执行中引导、停止请求及 Bash 进程树；当前没有固定40次模型调用上限。
- Responses API、本地完整历史续传、每个 session 的缓存命中量与命中率展示；支持可配置 API Key、URL 和模型。
- 按 session 展示 DeepSeek Flash 的人民币费用估算：先按请求时段累计美元费用，再按每日更新的 [USD/CNY 中间汇率](https://frankfurter.dev/)折算；汇率变化时历史 session 的人民币金额也会更新。节假日从 [Hi8 节假日 API](https://hi8.com/t/jiejiari-api) 启动时同步并每日更新到本地缓存，失败时保留旧数据，网页可手动标记。其他模型及缺少分时记录的旧用量不估价。
- Labor Agent 服务启动时自动打开默认浏览器。AI 与 Labor Agent 的日常协作使用 MCP 工具，不由 AI 打开或操作网页；用户仍可直接在网页中查看和手动操作。无浏览器环境仍可通过 MCP 工具使用服务。
- 服务会在模型请求前估算 session 上下文预算；达到配置阈值时会拦截本轮请求并提示 AI 创建新的 session，避免先请求再收到上下文超限错误。
- 网页会渲染用户和 Agent 回复中的常用 Markdown，包括标题、列表、链接、引用、表格和代码块；工具结果保持纯文本展示。
- 左下角“执行账号与模型”可以统一切换 DeepSeek API 或 Codex 订阅；DeepSeek 的 API 地址、模型、Key 可保存多个配置，Codex 账号和模型也在这里选择。新建 session 只选择项目文件夹，并自动继承当前全局执行设置。
- 网页左侧“＋”可以新建 session 并选择项目文件夹；目录会作为 workspace 保存。使用 Codex 全局设置时，该目录会作为 Codex thread 的 `cwd`，便于 Codex 按项目展示。
- 统计页提供 Token 消耗热图、输出速度曲线和费用估算；费用只对有对应渠道用量数据的请求估算，不代表最终账单。

## 部署

需要 **Node.js 22+、npm 和 Bash**。Windows 推荐 Git Bash，默认自动检测；其他系统默认使用 `/bin/bash`。

在项目目录执行：

```powershell
npm ci
# 已有 .env 时保留，不要覆盖
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

编辑 `.env`：

```dotenv
LABOR_API_KEY=你的密钥
LABOR_BASE_URL=https://api.deepseek.com
LABOR_MODEL=deepseek-flash
LABOR_CACHE_MODE=local
LABOR_PORT=3210
```

URL/模型填写账号或兼容网关实际支持的值。`local` 保存并续传完整历史，服务端缓存命中以接口返回为准；仅支持服务端续接的网关才使用 `previous_response_id`。

```powershell
npm run build
npm run start:bg
```

网页默认位于 **http://127.0.0.1:3210/**，服务启动后会自动打开默认浏览器；无图形界面时可手动访问该地址。`npm start` 为前台启动；修改 `.env` 后运行 `npm run restart`。其他命令：`npm run status`、`npm run stop`。日志和会话默认位于 `.labor-agent/`。

macOS/Linux 可用 `test -f .env || cp .env.example .env` 代替上面的复制命令，其余 npm 命令相同。

## MCP 与 skill 安装

DeepInfra 可在左下角 API 配置中选择：`https://api.deepinfra.com/v1/openai`，模型 `deepseek-ai/DeepSeek-V4.1-Flash-1017`，协议 Chat Completions，档位 Flex。API Token 仅保存到本机数据目录。新 session 继承启用的渠道；Chat Completions 使用本地历史，支持工具循环、流式回复与缓存 token 统计，费用使用渠道返回的 `estimated_cost`。Flex 单次超时下限为 15 分钟。Flash 1017 的输出配置上限为 32,768 tokens（同时受 `LABOR_MAX_OUTPUT_TOKENS` 限制，其他 DeepInfra 模型为 16,384）；推理与工具参数也占此预算，大文件应分段生成。截断时显示诊断且不执行该响应的工具调用，不自动重试或改用 Standard；可以发送新消息继续。

Codex 中执行：

```powershell
npm run setup:mcp
npm run setup:skill
```

- `setup:mcp` 将配置写入本项目 `.codex/config.toml`，使用 Node 和 `dist/mcp.js` 的绝对路径。重新打开/加载受信任的项目或客户端会话，使工具配置生效；其他项目需要在对应项目或客户端中另行配置。
- `setup:skill` 安装到 `$CODEX_HOME/skills/labor-agent`，未设置时使用 `~/.codex/skills/labor-agent`。若当前技能列表未刷新，重新打开会话。更新已有不同版本时使用 `npm run setup:skill -- --update`，这会覆盖已安装 skill。
- MCP 和 skill 是两部分：MCP 提供实际工具，skill 规定如何规划、委派和验收。首次 MCP 调用可自动启动后台，无需事先手动启动。

其他 MCP 客户端示例（替换为本机绝对路径；该 JSON 不是 Codex 的 TOML 格式）：

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

## 使用方式

在已加载 skill 和 MCP 的客户端中说：

> 使用 $labor-agent，在 D:/codes/my-project 按现有架构实现登录退出修复。先规划工作范围和验收标准，再派发执行；保留页面样式，验收退出、刷新和受保护路由行为。

主 AI 先规划目标、架构、工作/成果区域及验收标准，再通过 `agent_send` 派发。默认先看最终答复和报告；必要时先查最新任务轮的最近过程，再逐步展开，最后核验真实产物。同一任务的修正和恢复沿用会话，任务或阶段验收完成后，下一任务新建 session，只交接关键要求与成果路径。该切换由 MCP/skill 引导协调者执行，不会自动中断或切换运行中的会话。

为减少 DeepSeek 历史续传开销，普通工具结果默认只向模型提供最多 4,000 字符预览，可用 `LABOR_TOOL_CONTEXT_CHARS` 调整；完整捕获结果保留在会话记录中。Labor 需要细节时用其内部 `tool_result_get(result_id, offset, limit)` 分页读取（默认 4,000、最多 8,000 字符），无需重跑命令。文件 `read` 默认 80 行，仍可显式指定范围。Bash 超过捕获上限时保留首尾并标记，大日志应落在授权的成果文件中。已有历史不自动改写或总结。

MCP 入口：`agent_start`、`session_create/list/select/get`、`agent_send/status/wait/cancel`。AI 通过 MCP 选择会话、派发任务、等待和读取结果；服务启动时自动打开网页，网页也会显示指令、反馈和工具记录。

`session_get` 默认只给工具结果和参数的短预览，并限制返回字符数。需要查看具体结果时，将预览中的消息 `id` 传入 `message_ids` 获取完整文本；如 `textTruncated` 为 `true`，可增大 `max_chars`。也可用 `roles` 按角色筛选，或通过 `before_message_id` 向前分页。完整工具参数需显式传 `include_tool_args: true`。`agent_send` 和 `agent_status` 返回的工具记录同样使用短预览。

为减少主 AI 的轮询开销，长任务派发时给 `agent_send` 传 `wait_ms: 55000`；若仍返回 `running`，用 `agent_wait(wait_ms: 55000)`。它监听会话状态变化，在结束、报错或取消时提前返回。不要用 `agent_send` 发送“继续/等待”来轮询，因为运行中的发送会变成任务引导。

## 运行边界与开发

服务默认仅监听本机。Bash 具有当前用户权限，**不是安全沙箱**；只运行可信任务。不要提交 `.env`、密钥或 `.labor-agent/` 会话数据。中止不会回滚已经写入的文件。

```powershell
npm run check
npm test
```

测试使用本地模拟模型服务，不消耗真实模型 API。
