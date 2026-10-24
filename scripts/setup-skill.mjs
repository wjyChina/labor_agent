import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'skills', 'labor-agent');
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const destination = path.join(codexHome, 'skills', 'labor-agent');
const files = ['SKILL.md', path.join('agents', 'openai.yaml')];
// Refuse to overwrite a locally changed skill unless explicitly requested.
for (const file of files) {
  const target = path.join(destination, file);
  if (fs.existsSync(target) && !fs.readFileSync(target).equals(fs.readFileSync(path.join(source, file))) && !process.argv.includes('--update')) {
    console.error(`技能文件已有不同内容：${target}\n确认更新时运行 npm run setup:skill -- --update。`);
    process.exit(1);
  }
}
for (const file of files) {
  const target = path.join(destination, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(source, file), target);
}
console.log(`已安装 Labor Agent skill：${destination}\n可以使用 $labor-agent；若当前会话未刷新技能列表，请重新打开会话。`);
