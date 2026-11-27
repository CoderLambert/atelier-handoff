/**
 * @file 定义模型目录发现与全局网关配置契约。
 * @implementation 共享推理强度、网关模型目录 Zod 校验架构及应用运行配置类型。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { z } from 'zod';

export const reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

export const magpieModelPrefix = 'magpie:';

export const gatewayModelSchema = z.object({
  id: z.string().trim().max(200).regex(/^\S+$/u),
  displayName: z.string().min(1).max(200).optional(),
  supportedEfforts: z.array(z.enum(reasoningEfforts)).optional(),
  source: z.literal('magpie').optional(),
  provider: z.string().max(200).optional(),
  effort: z.string().max(40).optional(),
  serviceTier: z.string().max(40).optional(),
});

export const modelDiscoverySourceSchema = z.object({
  status: z.enum(['ready', 'partial', 'unavailable', 'stale', 'skipped']),
  reason: z
    .enum([
      'timeout',
      'process',
      'protocol',
      'http',
      'identity',
      'pagination-limit',
      'not-applicable',
    ])
    .optional(),
  modelCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative().optional(),
});

export const gatewayModelCatalogSchema = z.object({
  defaultModel: gatewayModelSchema.shape.id,
  routesAvailable: z.boolean(),
  models: z.array(gatewayModelSchema),
  discovery: z.object({
    routes: modelDiscoverySourceSchema,
    codex: modelDiscoverySourceSchema,
    magpie: modelDiscoverySourceSchema.optional(),
  }),
});

export type GatewayModelCatalog = z.infer<typeof gatewayModelCatalogSchema>;

export interface AppConfig {
  gateway: string;
  managedGateway?: boolean;
  magpieEnabled?: boolean;
  model: string;
  effort?: ReasoningEffort;
  limitExecution?: boolean;
  maxTurns: number;
  timeoutMs: number;
}
