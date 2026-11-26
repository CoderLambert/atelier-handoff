/**
 * @file 定义工作台快捷键的桌面桥接契约。
 * @implementation 限制原生快捷键注册的大小和命令标识，并为下发事件绑定当前注册版本。
 * @updated 2026-11-26T21:38:00+08:00
 */
import { z } from 'zod';
import { shortcutBindingSchema, shortcutCommandIdSchema } from './shortcuts.js';

const revisionSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);

export const desktopShortcutRegistrationSchema = z.strictObject({
  revision: revisionSchema,
  bindings: z
    .array(z.strictObject({ commandId: shortcutCommandIdSchema, binding: shortcutBindingSchema }))
    .max(32)
    .refine(
      (bindings) => new Set(bindings.map(({ commandId }) => commandId)).size === bindings.length,
    ),
});

export const desktopShortcutCommandSchema = z.strictObject({
  revision: revisionSchema,
  commandId: shortcutCommandIdSchema,
});
export const desktopShortcutUpdateResultSchema = z.undefined();

export const desktopShortcutChannels = {
  update: 'atelier-shortcuts:update',
  command: 'atelier-shortcuts:command',
} as const;

export type DesktopShortcutRegistration = z.infer<typeof desktopShortcutRegistrationSchema>;
export type DesktopShortcutCommand = z.infer<typeof desktopShortcutCommandSchema>;

export interface DesktopShortcutsBridge {
  update(registration: DesktopShortcutRegistration): Promise<void>;
  onCommand(listener: (event: DesktopShortcutCommand) => void): () => void;
}
