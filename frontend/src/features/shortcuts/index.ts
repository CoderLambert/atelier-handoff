/**
 * @file 导出工作台快捷操作的公共接口。
 * @implementation 隔离命令展示、配置与运行时，消费者只注入语义动作和上下文身份。
 * @updated 2026-11-26T22:00:00+08:00
 */
export { ShortcutHost } from './shortcut-host';
export { ShortcutSettings } from './shortcut-settings';
export { useShortcutCommandLabels, type ShortcutCommand } from './commands';
