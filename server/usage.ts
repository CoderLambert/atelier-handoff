import type { Usage } from '../shared/types.js';

interface ResultUsage {
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  total_cost_usd?: number;
  is_error: boolean;
}

export function readRunUsage(result: ResultUsage, model: string, previousCost: number | null) {
  const count = (value?: number | null) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const raw = result.usage;
  const input = count(raw?.input_tokens);
  const output = count(raw?.output_tokens);
  const cacheRead = count(raw?.cache_read_input_tokens);
  const cacheCreation = count(raw?.cache_creation_input_tokens);
  const measured = [input, output, cacheRead, cacheCreation].some(value => (value ?? 0) > 0);
  const zeroedError = result.is_error && !measured;
  const total = result.total_cost_usd;
  const cumulativeCost = !zeroedError && typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null;
  const estimate = cumulativeCost !== null && previousCost !== null && cumulativeCost >= previousCost ? cumulativeCost - previousCost : null;
  const usage: Usage = {
    model,
    inputTokens: zeroedError ? null : input,
    outputTokens: zeroedError ? null : output,
    cacheReadTokens: zeroedError ? null : cacheRead,
    cacheCreationTokens: zeroedError ? null : cacheCreation,
    sdkEstimateUsd: estimate,
    costEstimateUsd: null,
    pricingBasis: 'unknown',
    complete: !result.is_error && input !== null && output !== null,
  };
  return { usage, cumulativeCost };
}
