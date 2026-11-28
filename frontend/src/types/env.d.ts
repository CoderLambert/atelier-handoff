/**
 * @file 前端全局环境与宿主桥接类型声明。
 * @implementation 集中定义挂载在 window 上的桌面、快捷键与通知宿主桥接对象。
 * @updated 2026-11-26T21:38:00+08:00
 */
import type { DesktopBrowserBridge } from '@shared/desktop-browser';
import type { DesktopFilesBridge } from '@shared/desktop-files';
import type { DesktopUiNotificationsBridge } from '@shared/desktop-ui-notifications';
import type { DesktopGitBridge } from '@shared/desktop-git';
import type { DesktopShortcutsBridge } from '@shared/desktop-shortcuts';
import type { DesktopChannelsBridge } from '@shared/channels';

declare global {
  interface Window {
    atelierDesktop?: DesktopBrowserBridge;
    atelierDesktopFiles?: DesktopFilesBridge;
    atelierUiNotifications?: DesktopUiNotificationsBridge;
    atelierGit?: DesktopGitBridge;
    atelierShortcuts?: DesktopShortcutsBridge;
    atelierChannels?: DesktopChannelsBridge;
  }
}

export {};
