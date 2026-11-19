/**
 * @file 声明工作台可用的桌面文件能力。
 * @implementation 通过可选 preload 契约区分桌面与 Web，不暴露文件系统路径操作。
 * @updated 2026-11-20T11:00:00+08:00
 */
import type { DesktopFilesBridge } from '@shared/desktop-files';

declare global {
  interface Window {
    atelierDesktopFiles?: DesktopFilesBridge;
  }
}

export function desktopFilesBridge(): DesktopFilesBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.atelierDesktopFiles;
}
