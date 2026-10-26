const $ = id => document.getElementById(id);
let state = null, codexState = null, connected = false, sending = false, refreshTimer, toastTimer, rendered = '', sidebarRendered = '', syncedHolidayOverrideKey = '', lastHolidaySyncKey = '', lastHolidaySyncAt = 0, holidaySyncQueue = Promise.resolve();
const labels = { idle: '待命', running: '执行中', error: '执行异常', cancelled: '已停止' };
function node(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
function toast(text) { $('toast').textContent = text; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 6000); }
async function api(url, body) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
}
let settingsState = null, providerDraftId = null;
async function loadSettings(force = false) {
  if (settingsState && !force) return settingsState;
  settingsState = await api('/api/settings'); return settingsState;
}
function selectedProvider() { return settingsState?.providers?.profiles?.find(profile => profile.id === $('provider-profile').value); }
function selectedSettingsCodexProfile() { return settingsState?.codex?.profiles?.find(profile => profile.id === $('settings-codex-profile').value); }
function renderProviderEditor() {
  const select = $('provider-profile'), previous = providerDraftId || select.value;
  select.replaceChildren();
  for (const profile of settingsState?.providers?.profiles || []) { const option = node('option', '', `${profile.label}${profile.apiKeyConfigured ? ' · 已配置 Key' : ' · 未配置 Key'}`); option.value = profile.id; select.append(option); }
  const active = settingsState?.executionDefaults?.backend === 'deepseek' ? settingsState.executionDefaults.profileId : undefined;
  providerDraftId = previous && settingsState?.providers?.profiles?.some(profile => profile.id === previous) ? previous : active || settingsState?.providers?.profiles?.[0]?.id;
  if (providerDraftId) select.value = providerDraftId;
  const profile = selectedProvider();
  $('provider-label').value = profile?.label || '';
  $('provider-base-url').value = profile?.baseUrl || 'https://api.deepseek.com';
  $('provider-model').value = profile?.model || 'deepseek-flash';
  $('provider-kind').value = profile?.kind || 'deepseek';
  $('provider-format').value = profile?.apiFormat || 'responses';
  $('provider-tier').value = profile?.serviceTier || 'default';
  $('provider-api-key').value = '';
  $('provider-api-key').placeholder = profile?.apiKeyConfigured ? `已保存 ${profile.apiKeyPreview || 'Key'}，留空保持不变` : '请输入 API Key';
  $('provider-previous').checked = profile?.cacheMode === 'previous_response_id';
  $('provider-reasoning').value = profile?.reasoningEffort || 'high';
  updateProviderControls();
  $('provider-delete').disabled = (settingsState?.providers?.profiles?.length || 0) <= 1;
}
function updateProviderControls() {
  const chat = $('provider-format').value === 'chat_completions';
  $('provider-previous').disabled = chat;
  if (chat) $('provider-previous').checked = false;
  $('provider-tier').disabled = !chat;
  $('provider-tier-hint').classList.toggle('hidden', !chat || $('provider-tier').value !== 'flex');
}
function renderCodexSettings() {
  const profileSelect = $('settings-codex-profile'), modelSelect = $('settings-codex-model'), previousProfile = profileSelect.value, previousModel = modelSelect.value;
  profileSelect.replaceChildren(); modelSelect.replaceChildren();
  for (const profile of settingsState?.codex?.profiles || []) {
    const option = node('option', '', `${profile.label}${profile.email ? ` · ${profile.email}` : ''}${profile.loggedIn ? '' : ' · 未登录'}`); option.value = profile.id; option.disabled = !profile.loggedIn; profileSelect.append(option);
  }
  const defaults = settingsState?.executionDefaults || {};
  const chosen = settingsState?.codex?.profiles?.find(profile => profile.id === previousProfile && (profile.loggedIn || profile.login))
    || settingsState?.codex?.profiles?.find(profile => profile.id === defaults.profileId && profile.loggedIn)
    || settingsState?.codex?.profiles?.find(profile => profile.loggedIn)
    || settingsState?.codex?.profiles?.[0];
  if (chosen) profileSelect.value = chosen.id;
  const profile = selectedSettingsCodexProfile();
  for (const model of profile?.models || []) { const option = node('option', '', model.displayName || model.model); option.value = model.model; modelSelect.append(option); }
  const chosenModel = profile?.models?.find(model => model.model === previousModel) || profile?.models?.find(model => model.model === defaults.model) || profile?.models?.find(model => model.isDefault) || profile?.models?.[0];
  if (chosenModel) modelSelect.value = chosenModel.model;
  $('settings-codex-permission').value = defaults.codexSandbox || 'danger-full-access';
  $('settings-codex-help').textContent = settingsState?.codex?.available
    ? (profile?.loggedIn ? '模型列表来自当前 Codex 账号。' : '该账号尚未登录，请点击登录。')
    : (settingsState?.codex?.error || '未找到 Codex CLI。');
  $('settings-codex-login').textContent = profile?.loggedIn || profile?.login ? '刷新' : '登录';
  $('settings-codex-login').disabled = !profile;
}
function renderSettings() {
  const backend = settingsState?.executionDefaults?.backend || 'deepseek';
  $('settings-backend').value = backend;
  $('deepseek-settings').classList.toggle('hidden', backend !== 'deepseek');
  $('codex-settings').classList.toggle('hidden', backend !== 'codex');
  renderProviderEditor(); renderCodexSettings();
  const info = $('settings-info'); info.replaceChildren();
  const current = backend === 'deepseek' ? selectedProvider() : selectedSettingsCodexProfile();
  info.append(node('dt', '', '当前配置'), node('dd', '', current?.label || '—'), node('dt', '', '状态'), node('dd', '', backend === 'deepseek' ? (current?.apiKeyConfigured ? 'API Key 已配置' : '未配置 API Key') : (current?.loggedIn ? 'Codex 已登录' : '未登录')));
}
async function openSettings(preferredBackend) {
  $('settings-error').classList.add('hidden'); $('settings-dialog').showModal();
  try { await loadSettings(true); if (preferredBackend) settingsState.executionDefaults.backend = preferredBackend; renderSettings(); }
  catch (error) { $('settings-error').textContent = error.message; $('settings-error').classList.remove('hidden'); }
}
async function selectExecution(backend, profileId, model) {
  await api('/api/execution/select', { backend, profile_id: profileId, model });
  settingsState = await loadSettings(true); await refresh(); renderSettings();
}
async function saveProvider() {
  const body = { ...(providerDraftId ? { id: providerDraftId } : {}), label: $('provider-label').value.trim(), baseUrl: $('provider-base-url').value.trim(), model: $('provider-model').value.trim(), cacheMode: $('provider-previous').checked ? 'previous_response_id' : 'local', reasoningEffort: $('provider-reasoning').value,
    kind: $('provider-kind').value, apiFormat: $('provider-format').value, serviceTier: $('provider-tier').value,
    ...( $('provider-api-key').value ? { apiKey: $('provider-api-key').value } : {}) };
  const result = await api('/api/providers', body); providerDraftId = result.provider.id; settingsState = await loadSettings(true); await selectExecution('deepseek', providerDraftId, result.provider.model);
  $('provider-api-key').value = ''; renderSettings(); toast('API 配置已保存并启用。');
}
async function loginSettingsCodex() {
  const profile = selectedSettingsCodexProfile(); if (!profile) return;
  const result = profile.loggedIn || profile.login ? await api(`/api/codex/${profile.id}/refresh`, {}) : await api(`/api/codex/${profile.id}/login`, {});
  const url = result.verificationUrl || result.authUrl;
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
  if (result.userCode) toast(`请在 OpenAI 页面输入验证码 ${result.userCode}，完成后点击刷新。`); else if (url) toast('请在打开的 OpenAI 页面完成登录，然后点击刷新。');
  settingsState = await loadSettings(true); renderSettings();
}
async function addSettingsCodex() {
  const result = await api('/api/codex', { add: true }); const url = result.verificationUrl || result.authUrl;
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
  if (result.userCode) toast(`请在 OpenAI 页面输入验证码 ${result.userCode}，完成后点击刷新。`);
  settingsState = await loadSettings(true); renderSettings();
}
async function useCodex() {
  const profile = selectedSettingsCodexProfile(), model = $('settings-codex-model').value;
  if (!profile?.loggedIn || !model) throw new Error('请先登录 Codex 并选择模型。');
  await api('/api/execution/select', { backend: 'codex', profile_id: profile.id, model,
    codex_sandbox: $('settings-codex-permission').value });
  settingsState = await loadSettings(true); await refresh(); renderSettings(); toast('Codex 已保存并启用。');
}
async function openNewSessionDialog() {
  $('new-session-error').classList.add('hidden'); $('new-session-title').value = '';
  $('new-session-workspace').value = state?.session?.workspace || state?.workspace || '';
  const current = state?.activeProvider || state?.executionDefaults || {};
  $('new-session-execution').textContent = `当前配置：${current.label || (current.backend === 'codex' ? `Codex · ${current.model || '默认模型'}` : `${current.model || state?.model || 'DeepSeek'}`)}`;
  $('new-session-dialog').showModal(); $('new-session-title').focus();
}
async function chooseFolder() {
  try {
    const result = await api('/api/dialog/select-folder', {});
    if (!result.cancelled && result.workspace) $('new-session-workspace').value = result.workspace;
  } catch (error) { toast(error.message); }
}
async function createSessionFromDialog(event) {
  event.preventDefault();
  const errorBox = $('new-session-error'); errorBox.classList.add('hidden');
  const body = { title: $('new-session-title').value.trim() || undefined, workspace: $('new-session-workspace').value.trim() };
  try {
    if (!body.workspace) throw new Error('请选择项目文件夹。');
    await api('/api/sessions/create', body); $('new-session-dialog').close(); rendered = ''; sidebarRendered = ''; await refresh();
  } catch (error) { errorBox.textContent = error.message; errorBox.classList.remove('hidden'); }
}
const time = value => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
function formatUsd(value) { return `USD $${Number(value || 0).toFixed(6)}`; }
function formatCny(usd, fx = state?.usdCnyRate) {
  if (!fx || !Number.isFinite(fx.rate)) return null;
  const cny = Number(usd || 0) * fx.rate;
  return `¥${new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(cny)}`;
}
function cacheHitRate(usage = {}) {
  const input = Math.max(0, Number(usage.input) || 0);
  const cached = Math.min(input, Math.max(0, Number(usage.cached) || 0));
  return input > 0 ? `${(cached / input * 100).toFixed(1)}%` : '—';
}
function contextBudgetSummary(budget = {}) {
  if (!budget || !Number.isFinite(Number(budget.ratio))) return '';
  const ratio = Number(budget.ratio);
  const percent = `${(ratio * 100).toFixed(1)}%`;
  const status = budget.status === 'warning' || budget.status === 'exceeded' ? ' · 请新建 session' : '';
  return `上下文 ${percent}${status}`;
}
function costSummary(usage = {}, fx = state?.usdCnyRate) {
  if (usage.providerEstimate) {
    const estimate = usage.providerEstimate;
    const partial = estimate.input < (usage.input || 0) || estimate.output < (usage.output || 0);
    return { label: `${partial ? '部分估算' : '费用估算'} ${formatCny(estimate.usd, fx) || formatUsd(estimate.usd)}`,
      title: `累计 DeepInfra API 返回的 estimated_cost：${formatUsd(estimate.usd)}，共 ${estimate.calls} 次调用。${usage.lastServiceTier ? `最近实际档位：${usage.lastServiceTier}。` : ''}${fx ? `按 USD/CNY ${fx.rate} 折算人民币。` : ''}最终以渠道账单为准。${partial ? '部分历史用量没有费用记录。' : ''}` };
  }
  const entries = Object.entries(usage.estimatedCosts || {});
  const hasUsage = (usage.input || 0) + (usage.output || 0) > 0;
  if (!entries.length) return {
    label: hasUsage ? '费用暂无估算' : `费用估算 ${formatCny(0, fx) || '汇率加载中'}`,
    title: hasUsage
      ? '该会话已有 token 用量，但没有模型调用时段的计价记录，无法准确回溯。当前只对 DeepSeek Flash 估算，新请求会开始记录费用。'
      : '当前 session 还没有产生模型 token 用量。',
  };
  const total = entries.reduce((sum, [, cost]) => sum + cost.usd, 0);
  const meteredInput = entries.reduce((sum, [, cost]) => sum + cost.input, 0);
  const meteredOutput = entries.reduce((sum, [, cost]) => sum + cost.output, 0);
  const meteredCached = entries.reduce((sum, [, cost]) => sum + cost.cached, 0);
  const partial = meteredInput < (usage.input || 0) || meteredOutput < (usage.output || 0) || meteredCached < (usage.cached || 0);
  if (!fx || !Number.isFinite(fx.rate)) return {
    label: '人民币折算待获取',
    title: `当前 USD 估算合计 ${formatUsd(total)}，汇率尚未加载，暂不能显示人民币金额。`,
  };
  const details = entries.map(([model, cost]) =>
    `${model}: ${formatCny(cost.usd, fx)}（${formatUsd(cost.usd)}），高峰 ${formatCny(cost.peakUsd, fx)}，低谷 ${formatCny(cost.offPeakUsd, fx)}；${cost.calls} 次调用；输入 ${cost.input.toLocaleString()}（缓存命中 ${cost.cached.toLocaleString()}），输出 ${cost.output.toLocaleString()} tokens；从 ${new Date(cost.since).toLocaleString('zh-CN')} 起记录。`);
  details.unshift(`按 ${fx.date} USD/CNY 中间价 1 USD = ${fx.rate} CNY 折算；整个 session 使用当前汇率，汇率更新后人民币显示会相应变化。来源：Frankfurter。`);
  details.unshift('按 DeepSeek Flash 官方峰谷单价估算；缓存命中是输入 token 的子集。');
  if (partial) details.push('部分历史用量没有计价记录，未计入估算。');
  return { label: `${partial ? '部分估算' : '费用估算'} ${formatCny(total, fx)}`, title: `${details.join('\n')}\n美元原始估算：${formatUsd(total)}` };
}
const holidayOverrideStorageKey = 'labor-agent.deepseek-holiday-date';
function beijingClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  return { ...parts, date: `${parts.year}-${parts.month}-${parts.day}` };
}
function updatePeakNotice() {
  const banner = $('peak-notice');
  if (!banner || !state) return;
  let isDeepSeek = false;
  try { isDeepSeek = new URL(state.baseUrl).hostname.toLowerCase() === 'api.deepseek.com'; } catch {}
  banner.classList.toggle('hidden', !isDeepSeek);
  if (!isDeepSeek) return;

  const clock = beijingClock(), weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(clock.weekday);
  const calendar = state.holidayCalendar;
  const calendarAvailable = calendar?.date === clock.date && calendar.available;
  const automaticHoliday = !!(calendarAvailable && calendar.automaticHoliday);
  let holiday = false;
  try { holiday = localStorage.getItem(holidayOverrideStorageKey) === clock.date; } catch {}
  const manualHoliday = holiday;
  holiday = manualHoliday || automaticHoliday;
  $('holiday-override').checked = manualHoliday;
  const minuteOfDay = Number(clock.hour) * 60 + Number(clock.minute);
  const weekdayPeak = weekday >= 1 && weekday <= 5 &&
    ((minuteOfDay >= 9 * 60 && minuteOfDay < 12 * 60) || (minuteOfDay >= 14 * 60 && minuteOfDay < 18 * 60));
  const peak = weekdayPeak && !holiday;
  const calendarNote = calendarAvailable && calendar.fetchedAt
    ? `自动节假日表更新于 ${new Date(calendar.fetchedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}。`
    : '自动节假日表暂不可用或尚未发布，请手动标记法定节假日。';
  banner.classList.toggle('peak-active', peak);
  $('peak-time').textContent = `北京时间 ${clock.hour}:${clock.minute}`;
  $('peak-title').textContent = holiday
    ? `${manualHoliday ? '手动标记' : '自动识别'}节假日 · 低谷时段`
    : peak ? '当前高峰时段' : '当前低谷时段';
  $('peak-detail').textContent = peak
    ? `工作日 09:00–12:00、14:00–18:00 为高峰；低谷价格约为高峰的一半。${calendarNote}`
    : holiday ? `法定节假日全天按低谷计，价格约为高峰的一半。${calendarNote}`
      : `工作日 09:00–12:00、14:00–18:00 为高峰；其余时段为低谷。${calendarNote}`;
}
async function syncHolidayOverride(force = false) {
  if (!state) return;
  let holiday = false;
  try { holiday = localStorage.getItem(holidayOverrideStorageKey) === beijingClock().date; } catch {}
  const date = beijingClock().date, key = `${date}:${holiday}`;
  if (syncedHolidayOverrideKey === key || (!force && lastHolidaySyncKey === key && Date.now() - lastHolidaySyncAt < 30000)) return;
  lastHolidaySyncKey = key; lastHolidaySyncAt = Date.now();
  const request = holidaySyncQueue.then(() => api('/api/pricing/holiday-override', { date, isHoliday: holiday }));
  holidaySyncQueue = request.catch(() => {});
  try { await request; syncedHolidayOverrideKey = key; } catch {}
}
function safeUrl(value) {
  const url = value.trim();
  if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(url) && !/^javascript:/i.test(url)) return url;
  return null;
}
function appendInline(parent, value) {
  let rest = value;
  const patterns = [
    { type: 'code', regex: /`([^`\n]+)`/ },
    { type: 'link', regex: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/ },
    { type: 'strong', regex: /\*\*([^*\n]+)\*\*|__([^_\n]+)__/ },
    { type: 'del', regex: /~~([^~\n]+)~~/ },
    { type: 'em', regex: /\*([^*\n]+)\*/ },
    { type: 'em', regex: /_([^_\n]+)_/ },
  ];
  while (rest) {
    let selected = null;
    for (const pattern of patterns) {
      const match = pattern.regex.exec(rest);
      if (!match || (selected && match.index >= selected.match.index)) continue;
      selected = { ...pattern, match };
    }
    if (!selected) { parent.append(document.createTextNode(rest)); break; }
    if (selected.match.index > 0) parent.append(document.createTextNode(rest.slice(0, selected.match.index)));
    const match = selected.match;
    if (selected.type === 'code') {
      parent.append(node('code', 'inline-code', match[1]));
    } else if (selected.type === 'link') {
      const href = safeUrl(match[2]);
      if (!href) parent.append(document.createTextNode(match[0]));
      else {
        const link = node('a', '', ''); appendInline(link, match[1]); link.href = href;
        if (/^https?:/i.test(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        parent.append(link);
      }
    } else {
      const tag = selected.type === 'strong' ? 'strong' : selected.type === 'del' ? 'del' : 'em';
      const child = node(tag); appendInline(child, match[1] || match[2]); parent.append(child);
    }
    rest = rest.slice(match.index + match[0].length);
  }
}
function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}
function isTableSeparator(line) {
  return tableCells(line).length > 0 && tableCells(line).every(cell => /^:?-{3,}:?$/.test(cell));
}
function appendTable(container, lines, index) {
  if (index + 1 >= lines.length || !/^\s*\|/.test(lines[index]) || !isTableSeparator(lines[index + 1])) return index;
  const headers = tableCells(lines[index]), separators = tableCells(lines[index + 1]);
  const table = node('table', 'markdown-table'), thead = node('thead'), headerRow = node('tr');
  headers.forEach((header, column) => {
    const cell = node('th'); appendInline(cell, header);
    const alignment = separators[column] || '';
    cell.style.textAlign = alignment.startsWith(':') && alignment.endsWith(':') ? 'center' : alignment.endsWith(':') ? 'right' : alignment.startsWith(':') ? 'left' : '';
    headerRow.append(cell);
  });
  thead.append(headerRow); table.append(thead);
  const tbody = node('tbody'); let cursor = index + 2;
  while (cursor < lines.length && /^\s*\|/.test(lines[cursor]) && lines[cursor].trim()) {
    const row = node('tr'); tableCells(lines[cursor]).forEach((value, column) => {
      const cell = node('td'); appendInline(cell, value);
      const header = thead.querySelectorAll('th')[column]; if (header) cell.style.textAlign = header.style.textAlign;
      row.append(cell);
    });
    tbody.append(row); cursor++;
  }
  if (tbody.children.length) table.append(tbody);
  container.append(table); return cursor;
}
function markdownBlockStart(line, nextLine = '') {
  return /^\s*(```|#{1,6}\s|>\s?|[-*_])/.test(line) || /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line) || (/^\s*\|/.test(line) && isTableSeparator(nextLine));
}
function content(text) {
  const container = node('div', 'text');
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n'); let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3).trim().split(/\s+/)[0]; const code = []; index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      const pre = node('pre', 'markdown-code'); const codeNode = node('code');
      if (/^[\w+-]+$/.test(language)) codeNode.dataset.language = language;
      codeNode.textContent = code.join('\n'); pre.append(codeNode); container.append(pre); continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { const h = node(`h${heading[1].length}`); appendInline(h, heading[2]); container.append(h); index++; continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { container.append(node('hr')); index++; continue; }
    const tableEnd = appendTable(container, lines, index); if (tableEnd !== index) { index = tableEnd; continue; }
    if (/^\s*>/.test(line)) {
      const quote = node('blockquote');
      while (index < lines.length && /^\s*>/.test(lines[index])) { appendInline(quote, lines[index].replace(/^\s*>\s?/, '')); if (/^\s*>/.test(lines[index + 1] || '')) quote.append(document.createElement('br')); index++; }
      container.append(quote); continue;
    }
    const unordered = /^\s*[-*+]\s+/.test(line), ordered = /^\s*\d+[.)]\s+/.test(line);
    if (unordered || ordered) {
      const list = node(ordered ? 'ol' : 'ul');
      if (ordered) { const start = line.match(/^\s*(\d+)/); if (start && start[1] !== '1') list.start = Number(start[1]); }
      while (index < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[index]) : /^\s*[-*+]\s+/.test(lines[index]))) {
        const item = node('li'); appendInline(item, lines[index].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, '')); list.append(item); index++;
      }
      container.append(list); continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && (paragraph.length === 0 || !markdownBlockStart(lines[index], lines[index + 1]))) paragraph.push(lines[index++]);
    const p = node('p'); paragraph.forEach((part, offset) => { appendInline(p, part); if (offset < paragraph.length - 1) p.append(document.createElement('br')); }); container.append(p);
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
function updateScrollBottomButton() {
  const scroller = $('conversation'), button = $('scroll-bottom');
  const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  const mainRect = scroller.parentElement.getBoundingClientRect();
  const conversationRect = scroller.getBoundingClientRect();
  button.style.bottom = `${Math.max(12, mainRect.bottom - conversationRect.bottom + 16)}px`;
  button.classList.toggle('hidden', !state?.session?.messages?.length || distance < 160);
}
$('conversation').addEventListener('scroll', updateScrollBottomButton, { passive: true });
$('scroll-bottom').addEventListener('click', () => {
  const scroller = $('conversation');
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
});
const scrollLayoutObserver = new ResizeObserver(updateScrollBottomButton);
scrollLayoutObserver.observe($('conversation'));
scrollLayoutObserver.observe($('messages'));
scrollLayoutObserver.observe($('composer'));
function render() {
  if (!state) return;
  const s = state.session, running = s?.status === 'running';
  const executionConfigured = state.executionDefaults?.backend === 'codex' || state.configured;
  const sessionConfigured = s ? (s.backend === 'codex' || state.configured) : executionConfigured;
  $('session-title').textContent = s?.title || '未选择会话';
  $('workspace').textContent = s?.workspace || state.workspace; $('workspace').title = $('workspace').textContent;
  const globalEngine = state.activeProvider;
  $('model').textContent = `${globalEngine?.label || 'DeepSeek'} · ${globalEngine?.model || state.model}`;
  $('model').title = s && state.sessionProvider && state.sessionProvider.backend !== globalEngine?.backend
    ? `全局默认：${globalEngine?.label || globalEngine?.backend} · ${globalEngine?.model || state.model}\n当前 session：${state.sessionProvider.label} · ${state.sessionProvider.model}`
    : '新建 session 将使用此全局配置。';
  $('engine-dot').classList.toggle('off', !sessionConfigured || !connected);
  updatePeakNotice();
  $('connection').textContent = connected ? '● 本地已连接' : '连接已断开';
  $('status').textContent = labels[s?.status] || '待命'; $('status').className = `status ${s?.status || ''}`;
  $('notice').classList.toggle('hidden', sessionConfigured && connected);
  $('notice').textContent = !connected ? '与本地服务的连接已断开，正在自动重连…' : state.executionDefaults?.backend === 'codex' ? '当前使用 Codex 订阅。可在左下角设置中切换执行账号、模型或 DeepSeek 配置。' : '尚未配置 API Key。请在左下角“执行账号与模型”中保存 DeepSeek API 配置。';
  const queued = s?.pendingGuidance || 0;
  $('run-caption').classList.toggle('hidden', !running && !queued);
  $('run-caption').replaceChildren(node('span', 'live-dot'), node('span', '', queued ? `${queued} 条引导待应用${running ? '，当前步骤结束后继续' : '，继续对话时处理'}` : '执行中，可以发送引导'));
  $('send').replaceChildren(document.createTextNode(running ? '引导' : '发送'), node('span', '', '↑'));
  $('stop').classList.toggle('hidden', !running);
  $('send').disabled = sending || !connected || !sessionConfigured || !s;
  $('prompt').disabled = sending || !s;
  $('prompt').placeholder = !s ? '等待 AI 创建会话' : running ? '补充要求或调整方向…' : '发送消息…';
  if (s) {
    const cost = costSummary(s.usage);
    const rate = cacheHitRate(s.usage);
    const budget = contextBudgetSummary(s.contextBudget);
    $('usage').textContent = `输入 ${s.usage.input.toLocaleString()} · 输出 ${s.usage.output.toLocaleString()} · 缓存命中 ${s.usage.cached.toLocaleString()}（命中率 ${rate}，包含在输入中）tokens · ${cost.label}${budget ? ` · ${budget}` : ''}`;
    $('usage').title = `缓存命中率 ${rate} = 缓存命中输入 token ÷ 输入 token。${s.contextBudget ? `\n上下文估算包含历史输入和预留输出：${s.contextBudget.estimatedRequestTokens.toLocaleString()}/${s.contextBudget.limitTokens.toLocaleString()} tokens。` : ''}\n${cost.title}`;
  } else { $('usage').textContent = ''; $('usage').removeAttribute('title'); }
  const listKey = JSON.stringify([state.activeSessionId, state.sessions]);
  if (listKey !== sidebarRendered) {
    sidebarRendered = listKey; $('sessions').replaceChildren(); $('session-count').textContent = state.sessions.length;
    if (!state.sessions.length) $('sessions').append(node('div', 'no-sessions', '等待 AI 创建会话'));
    for (const item of state.sessions) {
      const b = node('button', `session-item ${item.id === state.activeSessionId ? 'active' : ''}`); b.title = item.workspace;
      b.setAttribute('aria-current', item.id === state.activeSessionId ? 'true' : 'false'); b.append(node('strong', '', '◌  ' + item.title));
      const meta = node('div', 'session-meta'); meta.append(node('span', '', new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' · ' + time(item.updatedAt)), node('span', 'session-state', labels[item.status])); b.append(meta);
      const projectName = item.workspace.split(/[\\/]/).filter(Boolean).pop() || item.workspace;
      b.append(node('div', 'session-project', `⌂ ${projectName}${item.backend === 'codex' ? ` · Codex${item.codex?.model ? ` · ${item.codex.model}` : ''}` : ''}`));
      const cost = costSummary(item.usage), rate = cacheHitRate(item.usage);
      const budget = contextBudgetSummary(item.contextBudget);
      b.append(node('div', 'session-usage', `缓存命中率 ${rate} · ${cost.label}${budget ? ` · ${budget}` : ''}`));
      b.title = `${item.workspace}\n缓存命中率 ${rate} = 缓存命中输入 token ÷ 输入 token。${item.contextBudget ? `\n上下文估算 ${item.contextBudget.estimatedRequestTokens.toLocaleString()}/${item.contextBudget.limitTokens.toLocaleString()} tokens。` : ''}\n${cost.title}`;
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
  updateScrollBottomButton();
}
let refreshing = false, refreshAgain = false;
async function refresh() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try { state = await api('/api/state'); connected = true; await syncHolidayOverride(); render(); }
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
$('new-session').onclick = () => { void openNewSessionDialog(); };
$('codex-account').onclick = () => { void openSettings('codex'); };
$('new-session-form').onsubmit = event => { void createSessionFromDialog(event); };
$('choose-folder').onclick = () => { void chooseFolder(); };
$('settings').onclick = () => { void openSettings(); };
$('settings-backend').onchange = () => { if (settingsState) { settingsState.executionDefaults.backend = $('settings-backend').value; renderSettings(); } };
$('provider-profile').onchange = () => { providerDraftId = $('provider-profile').value; renderProviderEditor(); };
$('provider-new').onclick = () => { providerDraftId = null; $('provider-profile').value = ''; $('provider-label').value = ''; $('provider-base-url').value = 'https://api.deepseek.com'; $('provider-model').value = 'deepseek-flash'; $('provider-kind').value = 'deepseek'; $('provider-format').value = 'responses'; $('provider-tier').value = 'default'; $('provider-api-key').value = ''; $('provider-api-key').placeholder = '请输入 API Key'; updateProviderControls(); };
$('provider-kind').onchange = () => {
  const deepinfra = $('provider-kind').value === 'deepinfra';
  $('provider-base-url').value = deepinfra ? 'https://api.deepinfra.com/v1/openai' : 'https://api.deepseek.com';
  $('provider-model').value = deepinfra ? 'deepseek-ai/DeepSeek-V4.1-Flash-1017' : 'deepseek-flash';
  $('provider-format').value = deepinfra ? 'chat_completions' : 'responses';
  $('provider-tier').value = deepinfra ? 'flex' : 'default'; updateProviderControls();
};
$('provider-format').onchange = updateProviderControls;
$('provider-tier').onchange = updateProviderControls;
$('provider-save').onclick = () => { void saveProvider().catch(error => { $('settings-error').textContent = error.message; $('settings-error').classList.remove('hidden'); }); };
$('provider-delete').onclick = () => { void (async () => { await api(`/api/providers/${$('provider-profile').value}/delete`, {}); settingsState = await loadSettings(true); renderSettings(); })().catch(error => { $('settings-error').textContent = error.message; $('settings-error').classList.remove('hidden'); }); };
$('settings-codex-profile').onchange = () => { renderCodexSettings(); };
$('settings-codex-login').onclick = () => { void loginSettingsCodex().catch(error => { $('settings-error').textContent = error.message; $('settings-error').classList.remove('hidden'); }); };
$('settings-codex-add').onclick = () => { void addSettingsCodex().catch(error => { $('settings-error').textContent = error.message; $('settings-error').classList.remove('hidden'); }); };
$('codex-use').onclick = () => { void useCodex().catch(error => { $('settings-error').textContent = error.message; $('settings-error').classList.remove('hidden'); }); };
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
$('mobile-menu').onclick = () => $('sidebar').classList.toggle('open');
$('holiday-override').onchange = event => {
  try {
    if (event.target.checked) localStorage.setItem(holidayOverrideStorageKey, beijingClock().date);
    else localStorage.removeItem(holidayOverrideStorageKey);
  } catch {}
  updatePeakNotice(); void syncHolidayOverride(true);
};
setInterval(() => {
  updatePeakNotice(); void syncHolidayOverride();
  if (state?.holidayCalendar?.date !== beijingClock().date) void refresh();
}, 30000);
document.addEventListener('click', event => { if (innerWidth <= 700 && !event.target.closest('.sidebar') && !event.target.closest('#mobile-menu')) $('sidebar').classList.remove('open'); });
void refresh();
