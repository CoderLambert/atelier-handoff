/**
 * @file 声明运行轨迹中请求与 SDK 流的计时字段。
 * @implementation 将请求跨度与工作台观察到的流分开记录。两者有可靠关联时才合并在同一条。
 * @updated 2026-11-27T02:58:23+08:00
 */
import { z } from 'zod';

export const requestTimingLimit = 512;
const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = milliseconds.max(8_640_000_000_000_000);

export const modelRequestTimingSchema = z.object({
  startedAt: timestamp,
  durationMs: milliseconds,
  ttftMs: milliseconds.optional(),
  firstContentMs: milliseconds.optional(),
  attempts: z.number().int().positive().optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  failed: z.boolean().optional(),
});

export const sdkStreamTimingSchema = z.object({
  firstEventAt: timestamp,
  firstContentAfterEventMs: milliseconds.optional(),
  durationMs: milliseconds,
  ttftMs: milliseconds.optional(),
  lastToolFinishedAt: milliseconds.optional(),
  scope: z.enum(['main', 'subagent']),
  outcome: z.enum(['complete', 'interrupted']),
});

const requestTimingRowSchema = z.union([
  z.object({ request: modelRequestTimingSchema, stream: sdkStreamTimingSchema.optional() }),
  z.object({ request: z.undefined().optional(), stream: sdkStreamTimingSchema }),
]);

export const runRequestTimingSchema = z.object({
  records: z.array(requestTimingRowSchema).max(requestTimingLimit),
  omitted: z.number().int().nonnegative(),
});

export type ModelRequestTiming = z.infer<typeof modelRequestTimingSchema>;
export type SdkStreamTiming = z.infer<typeof sdkStreamTimingSchema>;
export type RunRequestTiming = z.infer<typeof runRequestTimingSchema>;
