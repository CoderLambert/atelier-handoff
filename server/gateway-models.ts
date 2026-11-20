/**
 * @file 汇集 Shunt 路由及适用的 Codex 模型目录。
 * @implementation 校验并读取本机网关路由；存在 chatgpt-plan 路由时合并 Codex 可见模型和路由元数据，失败时保留工作台默认模型。
 * @updated 2026-11-20T17:08:00+08:00
 */
import { z } from 'zod';
import type { AppConfig, GatewayModelCatalog } from '../shared/types.js';
import { codexModelCatalog } from './codex-model-catalog.js';

export const gatewayModelId = z.string().trim().max(200).regex(/^\S+$/u);
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
): Promise<GatewayModelCatalog> {
  const result: GatewayModelCatalog = {
    defaultModel: config.model,
    routesAvailable: false,
    models: [{ id: config.model }],
  };
  try {
    const gateway = new URL(config.gateway);
    if (
      !['http:', 'https:'].includes(gateway.protocol) ||
      !['127.0.0.1', 'localhost'].includes(gateway.hostname) ||
      gateway.username ||
      gateway.password ||
      gateway.search ||
      gateway.hash
    )
      return result;
    gateway.pathname = gateway.pathname.replace(/\/$/u, '') + '/routes';
    const response = await fetch(gateway, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) return result;
    const { data, routers } = routesPayload.parse(await response.json());
    const catalog = new Map<string, GatewayModelCatalog['models'][number]>([
      [config.model, { id: config.model }],
    ]);
    for (const entry of [...routers, ...data]) {
      const parsed = route.safeParse(entry);
      if (!parsed.success) continue;
      const { model, provider, effort, service_tier } = parsed.data;
      catalog.set(model, { id: model, provider, effort, serviceTier: service_tier });
    }
    if ([...catalog.values()].some((entry) => entry.provider === 'chatgpt-plan')) {
      const models = await loadCodexModels().catch(() => []);
      for (const entry of models) catalog.set(entry.id, { ...entry, ...catalog.get(entry.id) });
    }
    return { ...result, routesAvailable: true, models: [...catalog.values()] };
  } catch {
    return result;
  }
}
