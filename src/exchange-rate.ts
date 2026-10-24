import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './store.js';

export type ExchangeRate = {
  base: 'USD';
  quote: 'CNY';
  rate: number;
  date: string;
  fetchedAt: string;
  sourceUrl: string;
};

const sourceUrl = 'https://api.frankfurter.dev/v2/rate/usd/cny';

export class ExchangeRateCache {
  private current?: ExchangeRate;
  private interval?: NodeJS.Timeout;
  private updatePromise?: Promise<void>;

  constructor(private dataDir: string, private onUpdate: () => void = () => {}) {
    this.load();
  }

  private get cachePath() { return path.join(this.dataDir, 'exchange-rate.json'); }

  private load() {
    if (!fs.existsSync(this.cachePath)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (saved.base === 'USD' && saved.quote === 'CNY' &&
          Number.isFinite(saved.rate) && saved.rate > 0 && saved.rate < 100 &&
          /^\d{4}-\d{2}-\d{2}$/.test(saved.date) && Number.isFinite(Date.parse(saved.fetchedAt))) {
        this.current = { ...saved, sourceUrl };
      }
    } catch (error) {
      console.warn('无法读取汇率缓存，将在联网后重新获取。', error instanceof Error ? error.message : String(error));
    }
  }

  start() {
    if (this.interval) return;
    const update = () => {
      void this.refresh().catch(error => console.warn('汇率缓存写入失败。', error instanceof Error ? error.message : String(error)));
    };
    update();
    this.interval = setInterval(update, 24 * 60 * 60 * 1000);
    this.interval.unref();
  }

  get() { return this.current || null; }

  refresh() {
    if (this.updatePromise) return this.updatePromise;
    this.updatePromise = this.update().finally(() => { this.updatePromise = undefined; });
    return this.updatePromise;
  }

  private async update() {
    const response = await fetch(sourceUrl, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { date?: string; base?: string; quote?: string; rate?: number };
    if (payload.base !== 'USD' || payload.quote !== 'CNY' || typeof payload.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(payload.date) || !Number.isFinite(payload.rate) ||
        payload.rate! <= 0 || payload.rate! >= 100) throw new Error('返回的 USD/CNY 汇率无效。');
    const next: ExchangeRate = {
      base: 'USD', quote: 'CNY', rate: payload.rate!, date: payload.date,
      fetchedAt: new Date().toISOString(), sourceUrl,
    };
    const changed = !this.current || this.current.rate !== next.rate || this.current.date !== next.date;
    this.current = next;
    atomicWrite(this.cachePath, JSON.stringify(next, null, 2));
    if (changed) this.onUpdate();
  }
}
