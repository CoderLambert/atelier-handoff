/**
 * @file 汇集 Shunt 路由及适用的 Codex 模型目录。
 * @implementation 校验并读取本机网关路由；存在 chatgpt-plan 路由时合并 Codex 可见模型和路由元数据，失败时保留工作台默认模型。
 * @updated 2026-11-20T17:08:00+08:00
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { gatewayModelSchema, type AppConfig, type GatewayModelCatalog } from '../shared/types.js';
import { codexModelCatalog } from './codex-model-catalog.js';

export const gatewayModelId = gatewayModelSchema.shape.id;
const route = z.object({
  model: gatewayModelId,
  provider: z.string().max(200).optional(),
  effort: z.string().max(40).optional(),
  service_tier: z.string().max(40).optional(),
});
const routesPayload = z.object({
  data: z.array(z.unknown()),
  routers: z.array(z.unknown()).default([]),
});

export async function gatewayModels(
  config: AppConfig,
  loadCodexModels = codexModelCatalog,
  options: { refresh?: boolean } = {},
): Promise<GatewayModelCatalog> {
  const result: GatewayModelCatalog = {
    defaultModel: config.model,
    routesAvailable: false,
    models: [{ id: config.model }],
    discovery: {
      routes: { status: 'unavailable', reason: 'http', modelCount: 0 },
      codex: { status: 'skipped', reason: 'not-applicable', modelCount: 0 },
    },
  };
  let gateway: URL;
  try {
    gateway = new URL(config.gateway);
    if (
      !['http:', 'https:'].includes(gateway.protocol) ||
      !['127.0.0.1', 'localhost'].includes(gateway.hostname) ||
      gateway.username ||
      gateway.password ||
      gateway.search ||
      gateway.hash
    )
      return result;
  } catch {
    return result;
  }
  gateway.pathname = gateway.pathname.replace(/\/$/u, '') + '/routes';
  const catalog = new Map<string, GatewayModelCatalog['models'][number]>([
    [config.model, { id: config.model }],
  ]);
  let routeIdentity = 'unavailable';
  try {
    const response = await fetch(gateway, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw new Error('http');
    const payload = routesPayload.safeParse(await response.json());
    if (!payload.success) {
      result.discovery.routes.reason = 'protocol';
    } else {
      const { data, routers } = payload.data;
      const visibleRoutes = new Map<string, GatewayModelCatalog['models'][number]>();
      let rejectedCount = 0;
      for (const entry of [...routers, ...data]) {
        const parsed = route.safeParse(entry);
        if (!parsed.success) {
          rejectedCount++;
          continue;
        }
        const { model, provider, effort, service_tier } = parsed.data;
        // Missing fields on duplicate/router entries cannot erase known execution metadata.
        const value = {
          ...visibleRoutes.get(model),
          id: model,
          ...(provider === undefined ? {} : { provider }),
          ...(effort === undefined ? {} : { effort }),
          ...(service_tier === undefined ? {} : { serviceTier: service_tier }),
        };
        visibleRoutes.set(model, value);
        catalog.set(model, value);
      }
      routeIdentity = createHash('sha256')
        .update(
          JSON.stringify([...visibleRoutes.values()].sort((a, b) => a.id.localeCompare(b.id))),
        )
        .digest('hex');
      result.routesAvailable = true;
      result.discovery.routes = {
        status: rejectedCount ? 'partial' : 'ready',
        modelCount: visibleRoutes.size,
        ...(rejectedCount ? { rejectedCount, reason: 'protocol' as const } : {}),
      };
    }
  } catch (error) {
    result.discovery.routes.reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'timeout'
        : error instanceof SyntaxError
          ? 'protocol'
          : 'http';
  }
  const hasPlanRoute = [...catalog.values()].some((entry) => entry.provider === 'chatgpt-plan');
  // A managed gateway has a known ChatGPT provider even before its first explicit route appears.
  if (hasPlanRoute || config.managedGateway) {
    try {
      const supplemental = await loadCodexModels({
        source: JSON.stringify([gateway.href, Boolean(config.managedGateway), routeIdentity]),
        refresh: options.refresh,
      });
      result.discovery.codex = supplemental.discovery;
      for (const entry of supplemental.models)
        catalog.set(entry.id, { ...entry, ...catalog.get(entry.id) });
    } catch {
      result.discovery.codex = { status: 'unavailable', reason: 'process', modelCount: 0 };
    }
  }
  result.models = [...catalog.values()];
  return result;
}
