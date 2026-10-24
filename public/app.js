const $ = id => document.getElementById(id);
let state = null, connected = false, sending = false, refreshTimer, toastTimer, rendered = '', sidebarRendered = '';
const labels = { idle: '待命', running: '执行中', error: '执行异常', cancelled: '已停止' };
function node(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
function toast(text) { $('toast').textContent = text; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 6000); }
async function api(url, body) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
const time = value => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
function content(text) {
  const container = node('div', 'text');
  // A small safe renderer: all text uses textContent, including model-generated code.
  const parts = text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('```')) {
      const pre = node('pre'); pre.append(node('code', '', part.replace(/^```[^\n]*\n/, '').replace(/```$/, ''))); container.append(pre);
    } else container.append(node('p', '', part.trim()));
  }
  return container;
}
function message(m) {
  if (m.role === 'system') return node('div', 'system-message', m.text);
  if (m.role === 'tool') {
    const details = node('details', 'tool-entry'); details.dataset.messageId = m.id;
    const summary = node('summary');
    const description = typeof m.args === 'object' && m.args ? m.args.path || m.args.command || '' : '';
    summary.append(node('span', 'tool-name', m.tool), node('span', 'tool-description', description), node('span', `tool-state ${m.state === 'error' ? 'tool-error' : ''}`, { running: '执行中…', done: '已完成', error: '失败', skipped: '已跳过' }[m.state] || ''));
    details.append(summary, node('pre', 'tool-output', JSON.stringify(m.args, null, 2) + (m.text ? '\n\n' + m.text : '\n等待结果…'))); return details;
  }
  const fromCoordinator = m.role === 'user' && m.source === 'mcp';
  const wrapper = node('article', `message ${m.role}`); wrapper.append(node('div', 'avatar', m.role === 'user' ? (fromCoordinator ? '协' : '你') : 'L'));
  const body = node('div', 'message-body'), heading = node('div', 'message-heading');
  heading.append(node('span', '', m.role === 'user' ? (fromCoordinator ? '协作助手' : '你') : 'Labor Agent'));
  if (fromCoordinator) heading.append(node('span', 'source', 'MCP 对话'));
  if (m.kind === 'guidance') heading.append(node('span', `guidance-label ${m.delivery}`, m.delivery === 'queued' ? '引导 · 待应用' : '引导 · 已纳入上下文'));
  heading.append(node('time', '', time(m.time))); body.append(heading, content(m.text)); wrapper.append(body); return wrapper;
}
function render() {
  if (!state) return;
  const s = state.session, running = s?.status === 'running';
  $('session-title').textContent = s?.title || '未选择会话';
  $('workspace').textContent = s?.workspace || state.workspace; $('workspace').title = $('workspace').textContent;
  $('model').textContent = state.model; $('engine-dot').classList.toggle('off', !state.configured || !connected);
  $('connection').textContent = connected ? '● 本地已连接' : '连接已断开';
  $('status').textContent = labels[s?.status] || '待命'; $('status').className = `status ${s?.status || ''}`;
  $('notice').classList.toggle('hidden', state.configured && connected);
  $('notice').textContent = !connected ? '与本地服务的连接已断开，正在自动重连…' : '尚未配置 API Key。在项目 .env 中填写 LABOR_API_KEY，然后重启服务即可开始。';
  const queued = s?.pendingGuidance || 0;
  $('run-caption').classList.toggle('hidden', !running && !queued);
  $('run-caption').replaceChildren(node('span', 'live-dot'), node('span', '', queued ? `${queued} 条引导待应用${running ? '，当前步骤结束后继续' : '，继续对话时处理'}` : '执行中，可以发送引导'));
  $('send').replaceChildren(document.createTextNode(running ? '引导' : '发送'), node('span', '', '↑'));
  $('stop').classList.toggle('hidden', !running);
  $('send').disabled = sending || !connected || !state.configured || !s;
  $('prompt').disabled = sending || !s;
  $('prompt').placeholder = !s ? '等待 AI 创建会话' : running ? '补充要求或调整方向…' : '发送消息…';
  $('usage').textContent = s ? `输入 ${s.usage.input.toLocaleString()} · 输出 ${s.usage.output.toLocaleString()} · 缓存 ${s.usage.cached.toLocaleString()} tokens` : '';
  const listKey = JSON.stringify([state.activeSessionId, state.sessions]);
  if (listKey !== sidebarRendered) {
    sidebarRendered = listKey; $('sessions').replaceChildren(); $('session-count').textContent = state.sessions.length;
    if (!state.sessions.length) $('sessions').append(node('div', 'no-sessions', '等待 AI 创建会话'));
    for (const item of state.sessions) {
      const b = node('button', `session-item ${item.id === state.activeSessionId ? 'active' : ''}`); b.title = item.workspace;
      b.setAttribute('aria-current', item.id === state.activeSessionId ? 'true' : 'false'); b.append(node('strong', '', '◌  ' + item.title));
      const meta = node('div', 'session-meta'); meta.append(node('span', '', new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' · ' + time(item.updatedAt)), node('span', 'session-state', labels[item.status])); b.append(meta);
      b.onclick = async () => { try { await api(`/api/sessions/${item.id}/select`, {}); $('sidebar').classList.remove('open'); rendered = ''; await refresh(); } catch (e) { toast(e.message); } };
      $('sessions').append(b);
    }
  }
  const key = JSON.stringify([s?.id, s?.status, s?.messages]);
  if (key !== rendered) {
    const scroller = $('conversation'); const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 130 || !rendered;
    const openTools = new Set([...document.querySelectorAll('details[open]')].map(e => e.dataset.messageId));
    rendered = key; $('messages').replaceChildren();
    for (const m of s?.messages || []) { const n = message(m); if (openTools.has(m.id)) n.open = true; $('messages').append(n); }
    if (running) $('messages').append(node('div', 'typing', 'Agent 正在处理…'));
    if (!s?.messages.length) scroller.scrollTop = 0;
    else if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  }
}
let refreshing = false, refreshAgain = false;
async function refresh() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try { state = await api('/api/state'); connected = true; render(); }
  catch (e) { connected = false; render(); }
  finally { refreshing = false; if (refreshAgain) { refreshAgain = false; void refresh(); } }
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 50); }
const events = new EventSource('/api/events');
events.onmessage = scheduleRefresh; events.onopen = () => { connected = true; void refresh(); };
events.onerror = () => { connected = false; render(); };
$('composer').onsubmit = async event => {
  event.preventDefault(); const text = $('prompt').value.trim(); if (!text || sending) return;
  const draft = $('prompt').value; sending = true; render();
  try {
    const id = state?.activeSessionId;
    if (!id) throw new Error('请先让 AI 通过 MCP 创建会话。');
    await api(`/api/sessions/${id}/send`, { text, source: 'web' }); $('prompt').value = '';
  } catch (e) { $('prompt').value = draft; toast(e.message); }
  finally { sending = false; await refresh(); $('prompt').focus(); }
};
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } };
$('stop').onclick = async () => { if (!state?.activeSessionId) return; try { await api(`/api/sessions/${state.activeSessionId}/cancel`, {}); await refresh(); } catch (e) { toast(e.message); } };
$('settings').onclick = () => {
  const info = $('settings-info'); info.replaceChildren();
  for (const [label, value] of [['API Key', state?.configured ? '已配置（不向浏览器发送密钥）' : '尚未配置'], ['API 地址', state?.baseUrl], ['模型', state?.model], ['Bash', state?.bashPath], ['会话缓存', state?.cacheMode]]) info.append(node('dt', '', label), node('dd', '', value || '—'));
  $('settings-dialog').showModal();
};
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
$('mobile-menu').onclick = () => $('sidebar').classList.toggle('open');
document.addEventListener('click', event => { if (innerWidth <= 700 && !event.target.closest('.sidebar') && !event.target.closest('#mobile-menu')) $('sidebar').classList.remove('open'); });
void refresh();
