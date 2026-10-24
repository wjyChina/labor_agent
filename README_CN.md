# Labor Agent

[English](README_EN.md) · [详细说明](README.md)

把具体实现交给执行 Agent，把规划和验收留给主 AI。Labor Agent 默认连接 DeepSeek，支持 MCP 协作和实时网页对话；采用独立轻量内核，参考 DeepSeek Harness 极简交互，不依赖其安装程序。

## 为什么用它

- **省钱**：将适合的复杂代码实现和多步骤命令交给可配置的执行模型，主 AI 默认只看最终结果和必要证据，减少主模型的过程上下文与执行轮次。
- **省时**：执行 Agent 自主选工具、修改文件并自检；主 AI 可以同时做其他准备，发现偏差后在执行中补充“引导”。
- 简单改动仍由主 AI 直接完成，避免委派成本超过任务本身。实际费用和耗时取决于模型、任务和返工，不承诺固定节省比例。

## 主要功能

- 自主使用 `read / write / edit / bash`，通过普通对话接收任务和验收标准。
- stdio MCP 与网页共享后台、持久会话和执行记录；每个会话可指定工作目录。
- AI 创建/选择会话；网页可观察、对话、引导和停止，无新建会话按钮。
- 支持执行中引导、停止请求及 Bash 进程树；当前没有固定40次模型调用上限。
- Responses API、本地完整历史续传、缓存命中量展示；支持可配置 API Key、URL 和模型。
- 按 session 展示 DeepSeek Flash 的 USD 费用估算，按请求时段拆分峰谷价格；缓存命中按输入 token 子集计价。其他模型及缺少分时记录的旧用量不估价，法定节假日需在网页手动勾选。
- 首次协作时，skill 和 MCP 指令要求支持浏览器的客户端自动打开或复用网页。**打开动作由客户端完成**；纯 MCP/无浏览器客户端只获得地址，状态查询不会反复开页。

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

网页默认位于 **http://127.0.0.1:3210/**。`npm start` 为前台启动；修改 `.env` 后运行 `npm run restart`。其他命令：`npm run status`、`npm run stop`。日志和会话默认位于 `.labor-agent/`。

macOS/Linux 可用 `test -f .env || cp .env.example .env` 代替上面的复制命令，其余 npm 命令相同。

## MCP 与 skill 安装

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

主 AI 先规划目标、架构、工作/成果区域及验收标准，再通过 `agent_send` 派发。默认先看最终答复和报告；必要时先查最新任务轮的最近过程，再逐步展开，最后核验真实产物。相关工作沿用会话，不相关任务新建会话。

MCP 入口：`agent_start`、`session_create/list/select/get`、`agent_send/status/wait/cancel`。AI 连接后打开/复用网页，选择目标会话；网页会显示指令、反馈和工具记录。

`session_get` 默认只给工具结果和参数的短预览，并限制返回字符数。需要查看具体结果时，将预览中的消息 `id` 传入 `message_ids` 获取完整文本；如 `textTruncated` 为 `true`，可增大 `max_chars`。也可用 `roles` 按角色筛选，或通过 `before_message_id` 向前分页。完整工具参数需显式传 `include_tool_args: true`。`agent_send` 和 `agent_status` 返回的工具记录同样使用短预览。

为减少主 AI 的轮询开销，长任务派发时给 `agent_send` 传 `wait_ms: 55000`；若仍返回 `running`，用 `agent_wait(wait_ms: 55000)`。它监听会话状态变化，在结束、报错或取消时提前返回。不要用 `agent_send` 发送“继续/等待”来轮询，因为运行中的发送会变成任务引导。

## 运行边界与开发

服务默认仅监听本机。Bash 具有当前用户权限，**不是安全沙箱**；只运行可信任务。不要提交 `.env`、密钥或 `.labor-agent/` 会话数据。中止不会回滚已经写入的文件。

```powershell
npm run check
npm test
```

测试使用本地模拟模型服务，不消耗真实模型 API。
