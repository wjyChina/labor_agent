const $ = id => document.getElementById(id);
const colors = ['#64865b', '#cc9d58', '#758db2', '#b67b71', '#8c7eaa', '#53a29a', '#ac8b52', '#66839a'];
let data = null;
let selected = new Set();
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
  let input = 0, cached = 0, output = 0, calls = 0, speedOutput = 0, speedDuration = 0;
  for (const date of data?.days || []) for (const { metric } of dailyFor(date.date)) {
    input += metric.inputTokens || 0; cached += metric.cachedTokens || 0; output += metric.outputTokens || 0;
    calls += metric.calls || 0; speedOutput += metric.speedOutputTokens || 0; speedDuration += metric.speedDurationMs || 0;
  }
  return { input, cached, output, calls, speed: speedDuration ? speedOutput / (speedDuration / 1000) : 0 };
}
function renderCards() {
  const totals = summarize(), cacheRate = totals.input ? `${(totals.cached / totals.input * 100).toFixed(1)}%` : '—';
  const cards = [
    ['Token 总量', formatTokens(totals.input + totals.output), `${selected.size} 个配置`],
    ['输入 Token', formatTokens(totals.input), `缓存命中 ${formatTokens(totals.cached)}`],
    ['缓存命中率', cacheRate, '缓存 Token / 输入 Token'],
    ['输出 Token', formatTokens(totals.output), `${formatTokens(totals.calls)} 次模型调用`],
    ['平均输出速度', totals.speed ? `${totals.speed.toFixed(1)} token/s` : '—', '按成功调用的输出与耗时加权'],
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
function renderTokenChart() {
  const root = $('token-chart'), legend = $('token-legend'); legend.replaceChildren();
  if (!data?.days?.length || !selected.size) { root.innerHTML = '<div class="stats-empty">选择至少一个配置以查看 Token 用量</div>'; return; }
  const configs = selectedConfigs();
  for (const config of configs) {
    const item = el('span'), swatch = el('i', 'legend-swatch');
    swatch.style.backgroundColor = configColor(config); item.append(swatch, document.createTextNode(config.label)); legend.append(item);
  }
  const width = Math.max(360, root.clientWidth || 760), height = 250;
  const left = 55, right = 12, top = 13, bottom = 31, plotWidth = width - left - right, plotHeight = height - top - bottom;
  const rows = data.days.map(day => ({ date: day.date, metrics: day.byConfig || {} }));
  const sums = rows.flatMap(row => configs.map(config => {
    const metric = row.metrics[config.id];
    return metric ? (metric.inputTokens || 0) + (metric.outputTokens || 0) : 0;
  }));
  const max = sums.reduce((highest, value) => Math.max(highest, value), 1), step = Math.pow(10, Math.floor(Math.log10(max)));
  const tick = Math.max(step / 2, Math.ceil(max / 4 / (step / 2)) * step / 2), axisMax = Math.ceil(max / tick) * tick;
  const slot = plotWidth / Math.max(rows.length, 1), groupWidth = slot * .84;
  const configSlot = groupWidth / configs.length, barWidth = Math.max(1, Math.min(24, configSlot * .72));
  let svg = svgRoot(width, height);
  for (let i = 0; i <= 4; i++) {
    const value = axisMax * (4 - i) / 4, y = top + plotHeight * i / 4;
    svg += `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="chart-axis" x="${left - 7}" y="${y + 3}" text-anchor="end">${escapeXml(compact(value))}</text>`;
  }
  rows.forEach((row, dayIndex) => {
    configs.forEach((config, configIndex) => {
      const metric = row.metrics[config.id];
      if (!metric) return;
      const input = metric.inputTokens || 0, cached = Math.min(input, metric.cachedTokens || 0), output = metric.outputTokens || 0;
      const total = input + output;
      if (!total) return;
      const xCenter = left + dayIndex * slot + (slot - groupWidth) / 2 + configIndex * configSlot + configSlot / 2;
      const barHeight = total / axisMax * plotHeight, y = top + plotHeight - barHeight;
      const title = `${row.date} · ${config.label}\n总量 ${formatTokens(total)}\n输入 ${formatTokens(input)}（缓存 ${formatTokens(cached)}）\n输出 ${formatTokens(output)}`;
      svg += `<rect x="${xCenter - barWidth / 2}" y="${y}" width="${barWidth}" height="${Math.max(.8, barHeight)}" rx="2" fill="${configColor(config)}"><title>${escapeXml(title)}</title></rect>`;
    });
  });
  svg += xLabels(rows.map(row => row.date), left, plotWidth, height - 7, width) + '</svg>';
  root.innerHTML = svg;
}
function renderSpeedChart() {
  const root = $('speed-chart'), legend = $('speed-legend'); legend.replaceChildren();
  if (!data?.days?.length || !selected.size) { root.innerHTML = '<div class="stats-empty">选择至少一个配置以查看输出速度</div>'; return; }
  const configs = selectedConfigs(), width = Math.max(360, root.clientWidth || 760), height = 250;
  const left = 55, right = 12, top = 13, bottom = 31, plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maxValues = [];
  const lines = configs.map(config => ({ config, color: configColor(config), points: data.days.map(day => {
    const metric = day.byConfig?.[config.id];
    return metric?.speedDurationMs > 0 ? metric.speedOutputTokens / (metric.speedDurationMs / 1000) : null;
  }) }));
  for (const line of lines) for (const value of line.points) if (value !== null) maxValues.push(value);
  if (!maxValues.length) { root.innerHTML = '<div class="stats-empty">所选配置在这段时间里还没有可计算速度的成功调用</div>'; return; }
  const max = maxValues.reduce((highest, value) => Math.max(highest, value), 1), axisMax = Math.ceil(max / 5) * 5 || max;
  let svg = svgRoot(width, height);
  for (let i = 0; i <= 4; i++) {
    const value = axisMax * (4 - i) / 4, y = top + plotHeight * i / 4;
    svg += `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="chart-axis" x="${left - 7}" y="${y + 3}" text-anchor="end">${value.toFixed(value < 10 ? 1 : 0)}</text>`;
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
    for (const point of points) {
      if (!point) { flush(); continue; }
      segment.push(point);
    }
    flush();
    for (const point of points) if (point) svg += `<circle class="speed-point" fill="${line.color}" cx="${point.x}" cy="${point.y}" r="3"><title>${escapeXml(`${line.config.label}\n${point.date}: ${point.value.toFixed(1)} token/s`)}</title></circle>`;
    const item = el('div', 'speed-legend-item');
    const swatch = el('i', 'speed-legend-line'); swatch.style.backgroundColor = line.color;
    item.append(swatch, el('span', '', line.config.label)); legend.append(item);
  });
  svg += xLabels(data.days.map(day => day.date), left, plotWidth, height - 7, width) + '</svg>';
  root.innerHTML = svg;
}
function render() {
  if (!data) return;
  const configsRoot = $('configs'); configsRoot.replaceChildren();
  if (!data.configs.length) configsRoot.append(el('span', 'stats-muted', '暂时没有可用的 Token 记录。'));
  for (const [index, config] of data.configs.entries()) {
    const label = el('label', 'config-option'), input = document.createElement('input');
    input.type = 'checkbox'; input.checked = selected.has(config.id); input.value = config.id;
    input.addEventListener('change', () => { input.checked ? selected.add(config.id) : selected.delete(config.id); render(); });
    const text = el('span', '', config.label); text.title = config.label; label.append(input, text); label.style.setProperty('--config-color', colors[index % colors.length]); configsRoot.append(label);
  }
  $('period').textContent = `${data.startDate} 至 ${data.endDate} · 北京时间`;
  renderCards(); renderTokenChart(); renderSpeedChart();
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
    selected = previous.size ? new Set(data.configs.filter(config => previous.has(config.id)).map(config => config.id)) : new Set(data.configs.map(config => config.id));
    render();
  } catch (error) { $('error').textContent = error.message; $('error').classList.remove('hidden'); }
}
$('range').addEventListener('change', () => void load());
$('select-all').addEventListener('click', () => { selected = new Set(data?.configs.map(config => config.id) || []); render(); });
$('select-none').addEventListener('click', () => { selected.clear(); render(); });
window.addEventListener('resize', () => { if (data) { renderTokenChart(); renderSpeedChart(); } });
void load();
