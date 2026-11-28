/**
 * @file 定义开发桌面自动重启的私有进程消息。
 * @implementation 校验启动器请求、运行时空闲判定和 Electron 的重启确认。
 * @updated 2026-12-08T12:00:00+00:00
 */
import { z } from 'zod';

export const developmentRestartRequest = z.strictObject({
  type: z.literal('atelier-dev:restart'),
});
export const developmentRestartAccepted = z.strictObject({
  type: z.literal('atelier-dev:restarting'),
  port: z.int().min(1).max(65535),
});
export const developmentRestartProbe = z.strictObject({
  type: z.literal('atelier-dev:prepare-restart'),
  id: z.uuid(),
});
export const developmentRestartResult = z.strictObject({
  type: z.literal('atelier-dev:restart-result'),
  id: z.uuid(),
  ready: z.boolean(),
});
