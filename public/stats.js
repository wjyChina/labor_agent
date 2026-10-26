const $ = id => document.getElementById(id);
const colors = ['#64865b', '#cc9d58', '#758db2', '#b67b71', '#8c7eaa', '#53a29a', '#ac8b52', '#66839a'];
let data = null;
let selected = new Set();
let selectionInitialized = false;
function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}
function formatTokens(value) {
  const number = Math.round(Number(value) || 0);
  return new Intl.NumberFormat('zh-CN').format(number);
}
function compact(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
  if (number >= 10_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
  return formatTokens(number);
}
function selectedConfigs() { return (data?.configs || []).filter(config => selected.has(config.id)); }
function configColor(config) { return colors[Math.max(0, data?.configs.findIndex(item => item.id === config.id) ?? 0) % colors.length]; }
function dailyFor(date) {
  const source = data?.daysByDate?.get(date) || {};
  return selectedConfigs().map(config => ({ config, metric: source[config.id] || {
    inputTokens: 0, cachedTokens: 0, outputTokens: 0, calls: 0, speedOutputTokens: 0, speedDurationMs: 0,
  } }));
}
function summarize() {
  let input = 0, cached = 0, output = 0, calls = 0, speedOutput = 0, speedDuration = 0, costUsd = 0, costCalls = 0;
  for (const date of data?.days || []) for (const { metric } of dailyFor(date.date)) {
    input += metric.inputTokens || 0; cached += metric.cachedTokens || 0; output += metric.outputTokens || 0;
    calls += metric.calls || 0; speedOutput += metric.speedOutputTokens || 0; speedDuration += metric.speedDurationMs || 0;
    costUsd += metric.estimatedCostUsd || 0; costCalls += metric.costCalls || 0;
  }
  return { input, cached, output, calls, speed: speedDuration ? speedOutput / (speedDuration / 1000) : 0, costUsd, costCalls };
}
function amountValue(usd) {
  const rate = Number(data?.usdCnyRate?.rate);
  return Number.isFinite(rate) && rate > 0 ? usd * rate : usd;
}
function amountLabel(usd, decimals = 4) {
  const rate = Number(data?.usdCnyRate?.rate), value = amountValue(usd);
  return `${Number.isFinite(rate) && rate > 0 ? '¥' : '$'}${value.toFixed(decimals)}`;
}
function renderCards() {
  const totals = summarize(), cacheRate = totals.input ? `${(totals.cached / totals.input * 100).toFixed(1)}%` : '—';
  const fxAvailable = Number(data?.usdCnyRate?.rate) > 0;
  const cards = [
    ['Token 总量', formatTokens(totals.input + totals.output), `${selected.size} 个配置`],
    ['输入 Token', formatTokens(totals.input), `缓存命中 ${formatTokens(totals.cached)}`],
    ['缓存命中率', cacheRate, '缓存 Token / 输入 Token'],
    ['输出 Token', formatTokens(totals.output), `${formatTokens(totals.calls)} 次模型调用`],
    ['平均输出速度', totals.speed ? `${totals.speed.toFixed(1)} token/s` : '—', '按成功调用的输出与耗时加权'],
    ['费用估算', totals.costCalls ? amountLabel(totals.costUsd, 4) : '暂无', `${totals.costCalls} 次调用有费用记录${fxAvailable ? ' · 按当前汇率换算' : ''}`],
  ];
  const root = $('cards'); root.replaceChildren();
  for (const [label, value, detail] of cards) {
    const card = el('article', 'stats-card'); card.append(el('div', 'stats-card-label', label), el('div', 'stats-card-value', value), el('div', 'stats-card-sub', detail)); root.append(card);
  }
}
function svgRoot(width = 760, height = 250) {
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">`;
}
function xLabels(dates, left, plotWidth, y, width) {
  const maxLabels = width < 560 ? 5 : 8;
  const stride = Math.max(1, Math.ceil(dates.length / maxLabels));
  let out = '';
  dates.forEach((date, index) => {
    if (index % stride !== 0 && index !== dates.length - 1) return;
    const x = left + (dates.length <= 1 ? plotWidth / 2 : index * plotWidth / (dates.length - 1));
    out += `<text class="chart-axis" x="${x}" y="${y}" text-anchor="middle">${escapeXml(date.slice(5).replace('-', '/'))}</text>`;
  });
  return out;
}
function renderHeatmap() {
  const root = $('token-heatmap');
  if (!data?.days?.length || !selected.size) { root.innerHTML = '<div class="stats-empty">选择至少一个配置以查看 Token 消耗</div>'; $('heatmap-total').textContent = ''; return; }
  const totals = data.days.map(day => {
    const items = selectedConfigs().map(config => ({ config, metric: day.byConfig?.[config.id] }));
    const aggregate = items.reduce((sum, { metric }) => ({
      input: sum.input + (metric?.inputTokens || 0), cached: sum.cached + (metric?.cachedTokens || 0),
      output: sum.output + (metric?.outputTokens || 0),
    }), { input: 0, cached: 0, output: 0 });
    return { date: day.date, items, ...aggregate, total: aggregate.input + aggregate.output };
  });
  const rangeTotal = totals.reduce((sum, day) => sum + day.total, 0);
  $('heatmap-total').textContent = `${formatTokens(rangeTotal)} tokens`;
  const positive = totals.map(day => day.total).filter(value => value > 0).sort((a, b) => a - b);
  const quantile = ratio => positive.length ? positive[Math.min(positive.length - 1, Math.floor((positive.length - 1) * ratio))] : 0;
  const thresholds = [quantile(.2), quantile(.4), quantile(.6), quantile(.8)];
  const start = new Date(`${data.startDate}T00:00:00Z`), end = new Date(`${data.endDate}T00:00:00Z`);
  const paddedStart = new Date(start); paddedStart.setUTCDate(paddedStart.getUTCDate() - paddedStart.getUTCDay());
  const paddedEnd = new Date(end); paddedEnd.setUTCDate(paddedEnd.getUTCDate() + (6 - paddedEnd.getUTCDay()));
  const dayCount = Math.round((paddedEnd - paddedStart) / 86400000) + 1, weeks = dayCount / 7;
  const cell = 12, gap = 3, step = cell + gap, labelWidth = 29, top = 24;
  const width = labelWidth + weeks * step + 4, height = top + 7 * step + 4;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="每日 Token 消耗日历热力图">`;
  const weekdayNames = ['日', '', '二', '', '四', '', '六'];
  weekdayNames.forEach((name, row) => { if (name) svg += `<text class="heatmap-day-label" x="${labelWidth - 6}" y="${top + row * step + cell - 2}" text-anchor="end">${name}</text>`; });
  const totalsByDate = new Map(totals.map(day => [day.date, day]));
  const prevMonth = new Date(paddedStart);
  for (let column = 0; column < weeks; column++) {
    const weekDate = new Date(paddedStart); weekDate.setUTCDate(weekDate.getUTCDate() + column * 7);
    if (column === 0 || weekDate.getUTCMonth() !== prevMonth.getUTCMonth()) {
      svg += `<text class="heatmap-month-label" x="${labelWidth + column * step}" y="14">${weekDate.getUTCMonth() + 1}月</text>`;
      prevMonth.setTime(weekDate.getTime());
    }
  }
  const current = new Date(paddedStart);
  for (let index = 0; index < dayCount; index++) {
    const date = current.toISOString().slice(0, 10), x = labelWidth + Math.floor(index / 7) * step, y = top + (index % 7) * step;
    if (date >= data.startDate && date <= data.endDate) {
      const day = totalsByDate.get(date) || { input: 0, cached: 0, output: 0, total: 0, items: [] };
      const level = day.total === 0 ? 0 : day.total >= thresholds[3] ? 4 : day.total >= thresholds[2] ? 3 : day.total >= thresholds[1] ? 2 : 1;
      const details = day.items.filter(item => item.metric && (item.metric.inputTokens || item.metric.outputTokens || item.metric.estimatedCostUsd))
        .map(({ config, metric }) => `${config.label}: ${formatTokens((metric.inputTokens || 0) + (metric.outputTokens || 0))}`).join('\n');
      const title = `${date}\nToken ${formatTokens(day.total)} · 输入 ${formatTokens(day.input)} · 缓存 ${formatTokens(day.cached)} · 输出 ${formatTokens(day.output)}${details ? `\n${details}` : ''}`;
      svg += `<rect class="heatmap-cell heat-level-${level}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2"><title>${escapeXml(title)}</title></rect>`;
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  svg += '</svg>'; root.innerHTML = svg;
}
function renderTrendChart(chartId, legendId, mode) {
  const root = $(chartId), legend = $(legendId); legend.replaceChildren();
  const isMoney = mode === 'money';
  if (!data?.days?.length || !selected.size) { root.innerHTML = `<div class="stats-empty">选择至少一个配置以查看${isMoney ? '费用' : '输出速度'}</div>`; return; }
  const configs = selectedConfigs(), width = Math.max(360, root.clientWidth || 760), height = 250;
  const lines = configs.map(config => ({ config, color: configColor(config), points: data.days.map(day => {
    const metric = day.byConfig?.[config.id];
    if (isMoney) return metric?.costCalls > 0 ? amountValue(metric.estimatedCostUsd || 0) : null;
    return metric?.speedDurationMs > 0 ? metric.speedOutputTokens / (metric.speedDurationMs / 1000) : null;
  }) })).filter(line => line.points.some(value => value !== null));
  if (!lines.length) {
    root.innerHTML = `<div class="stats-empty">${isMoney ? '所选配置暂无逐次费用记录' : '所选配置暂无可计算速度的成功调用'}</div>`;
    return;
  }
  const values = lines.flatMap(line => line.points.filter(value => value !== null));
  const max = values.reduce((highest, value) => Math.max(highest, value), 0.0001);
  const axisMax = isMoney ? max * 1.12 : Math.max(1, Math.ceil(max * 1.12));
  const decimals = isMoney ? (axisMax < .1 ? 4 : axisMax < 1 ? 3 : 2) : (axisMax < 10 ? 1 : 0);
  const left = 59, right = 12, top = 13, bottom = 31, plotWidth = width - left - right, plotHeight = height - top - bottom;
  let svg = svgRoot(width, height);
  for (let i = 0; i <= 4; i++) {
    const value = axisMax * (4 - i) / 4, y = top + plotHeight * i / 4;
    const label = isMoney ? `${Number(data?.usdCnyRate?.rate) > 0 ? '¥' : '$'}${value.toFixed(decimals)}` : value.toFixed(decimals);
    svg += `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="chart-axis" x="${left - 7}" y="${y + 3}" text-anchor="end">${escapeXml(label)}</text>`;
  }
  lines.forEach(line => {
    const points = line.points.map((value, index) => value === null ? null : {
      x: left + (data.days.length <= 1 ? plotWidth / 2 : index * plotWidth / (data.days.length - 1)),
      y: top + plotHeight - value / axisMax * plotHeight, value, date: data.days[index].date,
    });
    let segment = [];
    const flush = () => {
      if (segment.length > 1) svg += `<path class="speed-path" stroke="${line.color}" d="${segment.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ')}"/>`;
      segment = [];
    };
    for (const point of points) { if (!point) { flush(); continue; } segment.push(point); }
    flush();
    for (const point of points) {
      if (!point) continue;
      const unit = isMoney ? amountLabel(point.value / (Number(data?.usdCnyRate?.rate) > 0 ? Number(data.usdCnyRate.rate) : 1), decimals) : `${point.value.toFixed(1)} token/s`;
      svg += `<circle class="speed-point" fill="${line.color}" cx="${point.x}" cy="${point.y}" r="3"><title>${escapeXml(`${line.config.label}\n${point.date}: ${unit}`)}</title></circle>`;
    }
    const item = el('div', 'speed-legend-item'), swatch = el('i', 'speed-legend-line');
    swatch.style.backgroundColor = line.color; item.append(swatch, el('span', '', line.config.label)); legend.append(item);
  });
  svg += xLabels(data.days.map(day => day.date), left, plotWidth, height - 7, width) + '</svg>';
  root.innerHTML = svg;
}
function renderSpeedChart() { renderTrendChart('speed-chart', 'speed-legend', 'speed'); }
function renderAmountChart() {
  const rate = data?.usdCnyRate;
  $('amount-note').textContent = rate?.rate ? `按当前汇率 1 USD = ¥${Number(rate.rate).toFixed(4)} 换算（${rate.date}）` : '暂无 USD/CNY 汇率，金额按 USD 显示';
  renderTrendChart('amount-chart', 'amount-legend', 'money');
}
function render() {
  if (!data) return;
  const configsRoot = $('configs'); configsRoot.replaceChildren();
  if (!data.configs.length) configsRoot.append(el('span', 'stats-muted', '暂时没有可用的 Token 记录。'));
  for (const [index, config] of data.configs.entries()) {
    const label = el('label', 'config-option'), input = document.createElement('input');
    input.type = 'checkbox'; input.checked = selected.has(config.id); input.value = config.id;
    input.addEventListener('change', () => { input.checked ? selected.add(config.id) : selected.delete(config.id); renderViews(); });
    const text = el('span', '', config.label); text.title = config.label; label.append(input, text); label.style.setProperty('--config-color', colors[index % colors.length]); configsRoot.append(label);
  }
  renderViews();
}
function renderViews() {
  if (!data) return;
  $('period').textContent = `${data.startDate} 至 ${data.endDate} · 北京时间`;
  renderCards(); renderHeatmap(); renderSpeedChart(); renderAmountChart();
}
async function load() {
  $('error').classList.add('hidden');
  try {
    const response = await fetch(`/api/stats/tokens?range=${encodeURIComponent($('range').value)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '统计数据读取失败');
    const previous = new Set(selected);
    data = result;
    data.daysByDate = new Map(data.days.map(day => [day.date, day.byConfig]));
    selected = selectionInitialized ? new Set(data.configs.filter(config => previous.has(config.id)).map(config => config.id)) : new Set(data.configs.map(config => config.id));
    selectionInitialized = true;
    render();
  } catch (error) { $('error').textContent = error.message; $('error').classList.remove('hidden'); }
}
$('range').addEventListener('change', () => void load());
$('select-all').addEventListener('click', () => { selected = new Set(data?.configs.map(config => config.id) || []); render(); });
$('select-none').addEventListener('click', () => { selected.clear(); render(); });
window.addEventListener('resize', () => { if (data) { renderHeatmap(); renderSpeedChart(); renderAmountChart(); } });
void load();
