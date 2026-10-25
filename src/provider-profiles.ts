import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { AppError, atomicWrite, type ExecutionDefaults, Store } from './store.js';

export type DeepSeekProfile = {
  id: string; label: string; kind: 'deepseek'; baseUrl: string; model: string;
  apiKey: string; cacheMode: Config['cacheMode']; reasoningEffort: Config['reasoningEffort'];
};
export type ProviderProfileInput = {
  id?: string; label: string; baseUrl: string; model: string; apiKey?: string;
  cacheMode?: Config['cacheMode']; reasoningEffort?: Config['reasoningEffort'];
};

const inputSchema = z.object({
  id: z.string().min(1).max(100).optional(), label: z.string().trim().min(1).max(100),
  baseUrl: z.string().url(), model: z.string().trim().min(1).max(200), apiKey: z.string().max(500).optional(),
  cacheMode: z.enum(['local', 'previous_response_id']).default('local'),
  reasoningEffort: z.enum(['none', 'low', 'high', 'max']).default('high'),
});

export class ProviderProfiles {
  private profiles: DeepSeekProfile[];
  private file: string;
  constructor(readonly config: Config, private store: Store) {
    this.file = path.join(config.dataDir, 'provider-profiles.json');
    this.profiles = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
    if (!this.profiles.length) {
      this.profiles = [{ id: 'deepseek-default', label: 'DeepSeek 默认', kind: 'deepseek', baseUrl: config.baseUrl,
        model: config.model, apiKey: config.apiKey, cacheMode: config.cacheMode, reasoningEffort: config.reasoningEffort }];
      this.persist();
    }
    for (const profile of this.profiles) this.validate(profile);
  }
  private persist() { atomicWrite(this.file, JSON.stringify(this.profiles, null, 2)); }
  private validate(profile: DeepSeekProfile) {
    const url = new URL(profile.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('Provider API 地址必须是没有账号、查询参数的 HTTP(S) 地址。');
  }
  private get(id?: string) {
    const profile = this.profiles.find(p => p.id === id);
    if (!profile) throw new AppError('DeepSeek 配置不存在。', 404);
    return profile;
  }
  private preview(apiKey: string) {
    if (!apiKey) return undefined;
    return apiKey.length <= 8 ? '已配置' : `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}`;
  }
  publicProfile(profile: DeepSeekProfile) {
    const { apiKey, ...safe } = profile;
    return { ...safe, apiKeyConfigured: !!apiKey, apiKeyPreview: this.preview(apiKey) };
  }
  snapshot() { return { profiles: this.profiles.map(profile => this.publicProfile(profile)) }; }
  profile(id?: string) { return this.get(id || this.store.executionDefaults.profileId || this.profiles[0].id); }
  configFor(id?: string): Config {
    const profile = this.profile(id);
    return { ...this.config, apiKey: profile.apiKey, baseUrl: profile.baseUrl, model: profile.model,
      cacheMode: profile.cacheMode, reasoningEffort: profile.reasoningEffort };
  }
  async binding(value: ExecutionDefaults = { backend: 'deepseek' }): Promise<ExecutionDefaults> {
    if (value.backend !== 'deepseek') throw new AppError('当前不是 DeepSeek 配置。');
    const profile = this.profile(value.profileId);
    if (!profile.apiKey) throw new AppError(`配置“${profile.label}”还没有 API Key，请先在左下角设置中填写。`);
    return { backend: 'deepseek', profileId: profile.id, model: value.model || profile.model };
  }
  save(input: ProviderProfileInput) {
    const parsed = inputSchema.parse(input);
    const existing = parsed.id ? this.profiles.find(p => p.id === parsed.id) : undefined;
    const profile: DeepSeekProfile = { id: existing?.id || parsed.id || randomUUID(), label: parsed.label, kind: 'deepseek',
      baseUrl: parsed.baseUrl.replace(/\/+$/, ''), model: parsed.model,
      apiKey: parsed.apiKey !== undefined ? parsed.apiKey.trim() : existing?.apiKey || '',
      cacheMode: parsed.cacheMode, reasoningEffort: parsed.reasoningEffort };
    this.validate(profile);
    if (existing) Object.assign(existing, profile); else this.profiles.push(profile);
    this.persist(); this.store.emit('change', {}); return this.publicProfile(profile);
  }
  remove(id: string) {
    if (this.profiles.length <= 1) throw new AppError('至少保留一个 DeepSeek 配置。');
    if (this.store.executionDefaults.backend === 'deepseek' && this.store.executionDefaults.profileId === id)
      throw new AppError('当前正在使用此配置，请先切换到其他配置。', 409);
    const before = this.profiles.length; this.profiles = this.profiles.filter(p => p.id !== id);
    if (this.profiles.length === before) throw new AppError('DeepSeek 配置不存在。', 404);
    this.persist(); this.store.emit('change', {});
  }
}
