/**
 * @file 提供前端访问可选桌面文件桥的入口。
 * @implementation 声明 preload 暴露的文件桥类型，并在存在浏览器窗口时返回该桥；Web 环境可获得 `undefined`。
 * @updated 2026-11-23T18:25:00+08:00
 */
import type { DesktopFilesBridge } from '@shared/desktop-files';

export function desktopFilesBridge(): DesktopFilesBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.atelierDesktopFiles;
}
