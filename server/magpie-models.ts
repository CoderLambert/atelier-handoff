/**
 * @file 读取本机 Magpie 的模型目录并解析会话模型选择。
 * @implementation 校验回环地址和目录，使用独立的模型前缀和网关认证。
 * @updated 2026-11-22T13:30:00+08:00
 */
import { z } from 'zod';
import {
  gatewayModelSchema,
  magpieModelPrefix,
  reasoningEfforts,
  type GatewayModelCatalog,
} from '../shared/types.js';
export function magpieModel(model: string): string | undefined {
  return model.startsWith(magpieModelPrefix) ? model.slice(magpieModelPrefix.length) : undefined;
}

export function magpieOrigin(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    ) {
      return url.origin;
    }
  } catch {
    /* Invalid configuration does not enable discovery. */
  }
  return undefined;
}

const payloadSchema = z.object({
  data: z.array(z.unknown()).max(2000),
  has_more: z.boolean().optional(),
  last_id: z.string().max(200).nullable().optional(),
});
const modelSchema = z.object({
  id: gatewayModelSchema.shape.id,
  display_name: gatewayModelSchema.shape.displayName,
  owned_by: gatewayModelSchema.shape.provider,
  reasoning_levels: z.array(z.string()).optional(),
  tool_call: z.boolean().optional(),
  object: z.string().optional(),
});

type Source = NonNullable<GatewayModelCatalog['discovery']['magpie']>;
type Models = GatewayModelCatalog['models'];

export async function magpieModels(
  origin: string,
  cancellation?: AbortSignal,
): Promise<{ models: Models; discovery: Source }> {
  const models = new Map<string, Models[number]>();
  const cursors = new Set<string>();
  const timeout = AbortSignal.timeout(2200);
  const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
  const token = process.env.ATELIER_MAGPIE_TOKEN;
  let rejectedCount = 0;
  let reason: Source['reason'];
  let after: string | undefined;
  try {
    for (let page = 0; page < 8; page++) {
      const url = new URL('/v1/models', origin);
      if (after) url.searchParams.set('after_id', after);
      const response = await fetch(url, {
        signal,
        redirect: 'error',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) {
        reason = 'http';
        break;
      }
      const result = payloadSchema.safeParse(await response.json());
      if (!result.success) {
        reason = 'protocol';
        break;
      }
      for (const value of result.data.data) {
        const { data: model } = modelSchema.safeParse(value);
        if (!model || model.id.length + magpieModelPrefix.length > 200) {
          rejectedCount++;
          continue;
        }
        if ((model.object && model.object !== 'model') || model.tool_call === false) continue;
        const id = `${magpieModelPrefix}${model.id}`;
        models.set(id, {
          id,
          source: 'magpie',
          displayName: model.display_name,
          provider: model.owned_by,
          supportedEfforts:
            model.reasoning_levels &&
            reasoningEfforts.filter((level) => model.reasoning_levels?.includes(level)),
        });
      }
      if (!result.data.has_more) break;
      const cursor = result.data.last_id;
      if (page === 7 || !cursor || cursors.has(cursor)) {
        reason = 'pagination-limit';
        break;
      }
      cursors.add(cursor);
      after = cursor;
    }
  } catch (error) {
    reason = signal.aborted ? 'timeout' : error instanceof SyntaxError ? 'protocol' : 'http';
  }
  return {
    models: [...models.values()],
    discovery: {
      status: reason
        ? models.size
          ? 'partial'
          : 'unavailable'
        : rejectedCount
          ? 'partial'
          : 'ready',
      reason: reason ?? (rejectedCount ? 'protocol' : undefined),
      modelCount: models.size,
      ...(rejectedCount ? { rejectedCount } : {}),
    },
  };
}
