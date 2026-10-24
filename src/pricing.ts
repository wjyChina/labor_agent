export type EstimatedCost = {
  usd: number;
  peakUsd: number;
  offPeakUsd: number;
  calls: number;
  input: number;
  cached: number;
  output: number;
  since: string;
};

const flashRate = {
  peak: { input: 0.30, cacheHit: 0.006, output: 1.20 },
  offPeak: { input: 0.15, cacheHit: 0.003, output: 0.60 },
};

export function beijingDate(at: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function estimateDeepSeekFlash(input: {
  baseUrl: string; model: string; at: Date; holiday: boolean;
  inputTokens: number; cachedTokens: number; outputTokens: number;
}): { period: 'peak' | 'offPeak'; usd: number } | undefined {
  let host = '';
  try { host = new URL(input.baseUrl).hostname.toLowerCase(); } catch { return undefined; }
  if (host !== 'api.deepseek.com' || input.model.trim().toLowerCase() !== 'deepseek-flash') return undefined;

  const weekday = input.at.getUTCDay();
  const minute = input.at.getUTCHours() * 60 + input.at.getUTCMinutes();
  const weekdayPeak = weekday >= 1 && weekday <= 5 &&
    ((minute >= 60 && minute < 240) || (minute >= 360 && minute < 600));
  const period = weekdayPeak && !input.holiday ? 'peak' : 'offPeak';
  const rate = flashRate[period];
  const totalInput = Math.max(0, input.inputTokens);
  const cached = Math.min(totalInput, Math.max(0, input.cachedTokens));
  const uncached = totalInput - cached;
  const output = Math.max(0, input.outputTokens);
  const usd = (uncached * rate.input + cached * rate.cacheHit + output * rate.output) / 1_000_000;
  return { period, usd };
}
