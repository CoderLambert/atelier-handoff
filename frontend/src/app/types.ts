/**
 * @file 工作区应用层类型定义。
 * @implementation 集中维护会话操作、设置区块划分及跨组件交互类型。
 * @updated 2026-11-23T18:25:00+08:00
 */
export type SettingsSection = 'models' | 'layout' | 'shortcuts' | 'notifications' | 'diagnostics';
export type SessionAction = 'rename' | 'archive' | 'restore' | 'delete';
