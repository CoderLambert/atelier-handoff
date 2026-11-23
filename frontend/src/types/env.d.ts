/**
 * @file 前端全局环境与宿主桥接类型声明。
 * @implementation 集中定义挂载在 window 上的桌面与通知宿主桥接对象。
 * @updated 2026-11-23T18:25:00+08:00
 */
import type { DesktopBrowserBridge } from '@shared/desktop-browser';
import type { DesktopFilesBridge } from '@shared/desktop-files';
import type { DesktopUiNotificationsBridge } from '@shared/desktop-ui-notifications';

declare global {
  interface Window {
    atelierDesktop?: DesktopBrowserBridge;
    atelierDesktopFiles?: DesktopFilesBridge;
    atelierUiNotifications?: DesktopUiNotificationsBridge;
  }
}

export {};
