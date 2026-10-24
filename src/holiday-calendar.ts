import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './store.js';

type CachedYear = {
  year: number;
  holidays: string[];
  fetchedAt: string;
  sourceUpdated: string | null;
  sourceUrl: string;
};

export type HolidayCalendarStatus = {
  date: string;
  isHoliday: boolean;
  available: boolean;
  fetchedAt: string | null;
  sourceUpdated: string | null;
  sourceUrl: string;
};

const sourceUrl = (year: number) => `https://hi8.com/api/holiday/${year}.json`;

function validDate(value: unknown, year: number): value is string {
  if (typeof value !== 'string' || !new RegExp(`^${year}-\\d{2}-\\d{2}$`).test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export class HolidayCalendar {
  private years = new Map<number, CachedYear>();
  private interval?: NodeJS.Timeout;
  private updatePromise?: Promise<void>;

  constructor(private dataDir: string, private onUpdate: () => void = () => {}) {
    this.load();
  }

  private get cachePath() { return path.join(this.dataDir, 'holiday-calendar.json'); }

  private load() {
    if (!fs.existsSync(this.cachePath)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (saved.version !== 1 || !saved.years || typeof saved.years !== 'object') return;
      for (const [key, value] of Object.entries(saved.years)) {
        const year = Number(key), entry = value as Partial<CachedYear>;
        if (!Number.isInteger(year) || entry.year !== year || !Array.isArray(entry.holidays) ||
            !entry.holidays.length || !entry.holidays.every(date => validDate(date, year)) ||
            typeof entry.fetchedAt !== 'string' || !Number.isFinite(Date.parse(entry.fetchedAt))) continue;
        this.years.set(year, {
          year, holidays: [...new Set(entry.holidays)], fetchedAt: entry.fetchedAt,
          sourceUpdated: typeof entry.sourceUpdated === 'string' ? entry.sourceUpdated : null,
          sourceUrl: typeof entry.sourceUrl === 'string' ? entry.sourceUrl : sourceUrl(year),
        });
      }
    } catch (error) {
      console.warn('无法读取节假日日历缓存，将在联网后重新获取。', error instanceof Error ? error.message : String(error));
    }
  }

  start() {
    if (this.interval) return;
    const update = () => {
      void this.refresh().catch(error => console.warn('节假日日历缓存写入失败。', error instanceof Error ? error.message : String(error)));
    };
    update();
    this.interval = setInterval(update, 24 * 60 * 60 * 1000);
    this.interval.unref();
  }

  isHoliday(date: string) {
    const year = Number(date.slice(0, 4));
    return this.years.get(year)?.holidays.includes(date) || false;
  }

  status(date: string): HolidayCalendarStatus {
    const year = Number(date.slice(0, 4)), entry = this.years.get(year);
    return {
      date, isHoliday: entry?.holidays.includes(date) || false, available: !!entry,
      fetchedAt: entry?.fetchedAt || null, sourceUpdated: entry?.sourceUpdated || null,
      sourceUrl: entry?.sourceUrl || sourceUrl(year),
    };
  }

  refresh() {
    if (this.updatePromise) return this.updatePromise;
    this.updatePromise = this.update().finally(() => { this.updatePromise = undefined; });
    return this.updatePromise;
  }

  private async update() {
    const currentYear = Number(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric',
    }).format(new Date()));
    let changed = false;
    for (const year of [currentYear, currentYear + 1]) {
      const url = sourceUrl(year);
      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as {
          year?: number; published?: boolean; updated?: string;
          days?: Array<{ date?: unknown; isOffDay?: unknown }>;
        };
        if (payload.year !== year || payload.published !== true || !Array.isArray(payload.days)) continue;
        const holidays = [...new Set(payload.days
          .filter(day => day?.isOffDay === true && validDate(day.date, year))
          .map(day => day.date as string))].sort();
        if (!holidays.length || holidays.length > 100) throw new Error('节假日数据数量异常');
        const previous = this.years.get(year);
        if (!previous || JSON.stringify(previous.holidays) !== JSON.stringify(holidays)) changed = true;
        this.years.set(year, {
          year, holidays, fetchedAt: new Date().toISOString(),
          sourceUpdated: typeof payload.updated === 'string' ? payload.updated : null, sourceUrl: url,
        });
      } catch (error) {
        console.warn(`节假日数据更新失败（${year}），继续使用本地缓存。`, error instanceof Error ? error.message : String(error));
      }
    }
    atomicWrite(this.cachePath, JSON.stringify({ version: 1, years: Object.fromEntries(this.years) }, null, 2));
    if (changed) this.onUpdate();
  }
}
