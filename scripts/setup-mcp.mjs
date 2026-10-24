import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.codex');
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, 'config.toml');
const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
if (/^\[mcp_servers\.labor_agent\]/m.test(existing)) {
  console.log('labor_agent MCP 已存在：' + file);
} else {
  const q = value => JSON.stringify(value.replaceAll('\\', '/'));
  const config = `\n[mcp_servers.labor_agent]\ncommand = ${q(process.execPath)}\nargs = [${q(path.join(root, 'dist/mcp.js'))}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 75\n`;
  fs.appendFileSync(file, existing.endsWith('\n') || !existing ? config.trimStart() : config);
  console.log('已添加项目 MCP 配置：' + file);
  console.log('在 Codex 中重新打开此项目或重启会话以加载 MCP。');
}
