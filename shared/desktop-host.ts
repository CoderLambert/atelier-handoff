/**
 * @file 定义桌面宿主与运行时生命周期协议。
 * @implementation 校验私有 IPC 握手、就绪和启动故障，规定配对头与时间上限。
 * @updated 2026-11-20T02:00+08:00
 */
import { z } from 'zod';

export const desktopHostVersion = 2;
export const desktopPairingHeader = 'x-atelier-desktop-pairing';
export const desktopHostDeadlines = { ready: 12_000, window: 8_000, stop: 10_000 } as const;
const identity = {
  protocolVersion: z.literal(desktopHostVersion),
  generation: z.uuid(),
};
export const desktopHostHelloSchema = z.strictObject({
  ...identity,
  type: z.literal('atelier-host:hello'),
  pairing: z.string().regex(/^[a-f0-9]{64}$/),
});
export const desktopHostReplySchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...identity,
    type: z.literal('atelier-host:ready'),
    port: z.int().min(1).max(65535),
  }),
  z.strictObject({
    ...identity,
    type: z.literal('atelier-host:failed'),
    code: z.literal(['PORT_IN_USE', 'DATA_LOCKED', 'DATA_PATH', 'STARTUP_FAILED']),
  }),
]);
export type DesktopHostHello = z.infer<typeof desktopHostHelloSchema>;
export const desktopHostSystemResumeSchema = z.strictObject({
  protocolVersion: z.literal(desktopHostVersion),
  type: z.literal('atelier-host:system-resume'),
});
export type DesktopHostReply = z.infer<typeof desktopHostReplySchema>;
export type DesktopHostSystemResume = z.infer<typeof desktopHostSystemResumeSchema>;
export type DesktopHostFailure = Extract<DesktopHostReply, { type: 'atelier-host:failed' }>['code'];
