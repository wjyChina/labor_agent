import { z } from 'zod';

export const compressionConfigFields = {
  triggerRatio: z.number().min(0.1).max(0.95).describe('Fraction of the context window that triggers compression, e.g. 0.75 for 75%. Must not exceed the safety warning threshold.'),
  preserveRecentTokens: z.number().int().min(256).max(8000000).describe('Target tokens of recent verbatim context to retain; complete tool batches and recent user requests remain protected.'),
  preserveRecentMessages: z.number().int().min(1).max(100).describe('Minimum number of recent history items to retain, without splitting tool call/result pairs.'),
  summaryMaxTokens: z.number().int().min(256).max(131072).describe('Summary output budget, capped by the model request output limit.'),
};
export const compressionConfigSchema = z.object(compressionConfigFields).partial().strict();
export const compressionConfigPatchSchema = z.object({
  triggerRatio: compressionConfigFields.triggerRatio.nullable().optional(),
  preserveRecentTokens: compressionConfigFields.preserveRecentTokens.nullable().optional(),
  preserveRecentMessages: compressionConfigFields.preserveRecentMessages.nullable().optional(),
  summaryMaxTokens: compressionConfigFields.summaryMaxTokens.nullable().optional(),
}).strict();
export type CompressionConfig = z.infer<typeof compressionConfigSchema>;
export type ContextPolicy = { mode: 'handoff' | 'compress'; strategy: 'long' | 'short'; config?: CompressionConfig };
export type ContextPolicyPatch = { mode?: ContextPolicy['mode']; strategy?: ContextPolicy['strategy']; config?: z.infer<typeof compressionConfigPatchSchema> | null };
type RuntimeLimits = { contextLimitTokens: number; contextWarnRatio: number; maxOutputTokens: number };
const policySchema = z.object({ mode: z.enum(['handoff', 'compress']), strategy: z.enum(['long', 'short']), config: compressionConfigSchema.optional() }).strict();
// Existing installations retain their handoff behavior. Compression defaults
// to the long-context strategy whenever it is enabled.
export const defaultContextPolicy: ContextPolicy = { mode: 'handoff', strategy: 'long' };
export function validContextPolicy(value: any): value is ContextPolicy {
  return policySchema.safeParse(value).success;
}
export function updateContextPolicy(current: ContextPolicy, patch: ContextPolicyPatch): ContextPolicy {
  const config: CompressionConfig = patch.config === null ? {} : { ...current.config };
  if (patch.config) for (const key of Object.keys(compressionConfigFields) as (keyof CompressionConfig)[]) {
    const value = patch.config[key];
    if (value === null) delete config[key];
    else if (value !== undefined) config[key] = value;
  }
  return policySchema.parse({ mode: patch.mode || current.mode, strategy: patch.strategy || current.strategy,
    ...(Object.keys(config).length ? { config } : {}) });
}
export function resolveCompressionConfig(policy: ContextPolicy, limits: RuntimeLimits) {
  const long = policy.strategy === 'long', configured = policy.config || {};
  const inputRoom = Math.max(256, limits.contextLimitTokens - limits.maxOutputTokens);
  return {
    triggerRatio: Math.min(limits.contextWarnRatio, configured.triggerRatio ?? (long ? 0.75 : 0.45)),
    preserveRecentTokens: Math.min(inputRoom, configured.preserveRecentTokens ?? Math.min(long ? 24000 : 6000,
      Math.max(256, Math.floor(inputRoom * (long ? 0.15 : 0.06))))),
    preserveRecentMessages: configured.preserveRecentMessages ?? 3,
    summaryMaxTokens: Math.min(limits.maxOutputTokens, configured.summaryMaxTokens ?? (long ? 8192 : 2048)),
  };
}
export function validateCompressionConfig(policy: ContextPolicy, limits: RuntimeLimits, config = policy.config) {
  if (config?.triggerRatio !== undefined && config.triggerRatio > limits.contextWarnRatio)
    throw new Error(`压缩触发阈值不能高于安全预警阈值 ${Math.round(limits.contextWarnRatio * 100)}%。`);
  if (config?.preserveRecentTokens !== undefined && config.preserveRecentTokens > Math.max(256, limits.contextLimitTokens - limits.maxOutputTokens))
    throw new Error(`近期原文保留量不能超过可用输入预算 ${Math.max(256, limits.contextLimitTokens - limits.maxOutputTokens)} tokens。`);
  if (config?.summaryMaxTokens !== undefined && config.summaryMaxTokens > limits.maxOutputTokens)
    throw new Error(`摘要输出预算不能超过当前模型单次输出上限 ${limits.maxOutputTokens} tokens。`);
  if (config && Object.keys(config).length) {
    const resolved = resolveCompressionConfig(policy, limits);
    if (resolved.preserveRecentTokens + limits.maxOutputTokens >= limits.contextLimitTokens * resolved.triggerRatio)
      throw new Error('近期原文保留量与模型输出预留已达到压缩触发预算；请提高触发比例或减少原文保留量。');
  }
}
