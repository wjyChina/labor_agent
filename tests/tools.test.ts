import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ToolExecutor } from '../src/tools.js';
import { fixture } from './helpers.js';

test('file tools: create, paged read, exact edit, CRLF, overwrite and directory list', async () => {
  const f = fixture(); const tools = new ToolExecutor(f.config), signal = new AbortController().signal;
  try {
    const run = (name: string, args: unknown) => tools.execute(name, args, f.workspace, signal);
    await run('write', { path: 'src/a.txt', content: 'one\r\ntwo\r\nthree\r\n' });
    assert.match(await run('read', { path: 'src/a.txt', offset: 2, limit: 1 }), /2: two/);
    await run('edit', { path: 'src/a.txt', old_text: 'two\nthree', new_text: '二\n三' });
    assert.equal(fs.readFileSync(path.join(f.workspace, 'src/a.txt'), 'utf8'), 'one\r\n二\r\n三\r\n');
    await assert.rejects(run('write', { path: 'src/a.txt', content: 'x' }), /overwrite=true/);
    await run('write', { path: 'src/a.txt', content: 'x x', overwrite: true });
    await assert.rejects(run('edit', { path: 'src/a.txt', old_text: 'x', new_text: 'y' }), /匹配到 2/);
    await run('edit', { path: 'src/a.txt', old_text: 'x', new_text: '$&', replace_all: true });
    assert.equal(fs.readFileSync(path.join(f.workspace, 'src/a.txt'), 'utf8'), '$& $&');
    assert.match(await run('read', { path: '.' }), /\[dir\] src/);
  } finally { f.cleanup(); }
});
test('file tools reject traversal, secrets, internal data and junction escapes', async () => {
  const f = fixture(), tools = new ToolExecutor(f.config), signal = new AbortController().signal;
  try {
    for (const target of ['../escape.txt', '.env', '.env.local', f.dataDir])
      await assert.rejects(tools.execute('write', { path: target, content: 'x' }, f.workspace, signal));
    const link = path.join(f.workspace, 'outside');
    fs.symlinkSync(f.dataDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(tools.execute('write', { path: 'outside/escape.txt', content: 'x' }, f.workspace, signal), /符号链接/);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'escape.txt')), false);
  } finally { f.cleanup(); }
});
test('bash uses workspace, captures unicode, limits output, times out and cancels', async () => {
  const f = fixture(), tools = new ToolExecutor(f.config), signal = new AbortController().signal;
  try {
    const output = JSON.parse(await tools.execute('bash', { command: "printf '你好'; printf 'err' >&2; printf 'ok' > result.txt" }, f.workspace, signal));
    assert.equal(output.stdout, '你好'); assert.equal(output.stderr, 'err'); assert.equal(output.exit_code, 0);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'result.txt'), 'utf8'), 'ok');
    const bounded = JSON.parse(await tools.execute('bash', { command: "yes x | head -c 100000" }, f.workspace, signal));
    assert.equal(bounded.truncated, true); assert.ok(bounded.stdout.length <= 24000);
    const timed = JSON.parse(await tools.execute('bash', { command: 'sleep 20', timeout_ms: 150 }, f.workspace, signal));
    assert.match(timed.error, /超时/);
    const controller = new AbortController();
    const work = tools.execute('bash', { command: 'sleep 20' }, f.workspace, controller.signal);
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(work, /取消/);
  } finally { f.cleanup(); }
});
