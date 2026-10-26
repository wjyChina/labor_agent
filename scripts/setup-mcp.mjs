import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.codex');
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, 'config.toml');
const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const timeoutSeconds = 1860;
const header = /^\[mcp_servers\.labor_agent\]\s*$/m.exec(existing);
if (header) {
  const sectionStart = header.index;
  const contentStart = sectionStart + header[0].length;
  const nextSection = /^\[[^\]\r\n]+\]\s*$/m.exec(existing.slice(contentStart));
  const sectionEnd = nextSection ? contentStart + nextSection.index : existing.length;
  let section = existing.slice(sectionStart, sectionEnd);
  if (/^tool_timeout_sec\s*=\s*\d+\s*$/m.test(section))
    section = section.replace(/^tool_timeout_sec\s*=\s*\d+\s*$/m, `tool_timeout_sec = ${timeoutSeconds}`);
  else section = `${section.replace(/[\r\n]*$/, '')}\ntool_timeout_sec = ${timeoutSeconds}\n`;
  const updated = `${existing.slice(0, sectionStart)}${section}${existing.slice(sectionEnd)}`;
  if (updated !== existing) fs.writeFileSync(file, updated, 'utf8');
  console.log(`已设置 Labor Agent MCP 工具超时为 ${timeoutSeconds} 秒：${file}`);
} else {
  const q = value => JSON.stringify(value.replaceAll('\\', '/'));
  const config = `\n[mcp_servers.labor_agent]\ncommand = ${q(process.execPath)}\nargs = [${q(path.join(root, 'dist/mcp.js'))}]\nstartup_timeout_sec = 20\ntool_timeout_sec = ${timeoutSeconds}\n`;
  fs.appendFileSync(file, existing.endsWith('\n') || !existing ? config.trimStart() : config);
  console.log('已添加项目 MCP 配置：' + file);
  console.log('在 Codex 中重新打开此项目或重启会话以加载 MCP。');
}
