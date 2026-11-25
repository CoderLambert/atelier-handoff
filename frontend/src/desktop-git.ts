/**
 * @file 提供前端访问桌面端 Git 桥接接口的统一入口。
 * @implementation 声明类型化访问函数，桌面环境返回 window.atelierGit，Web 环境返回 undefined。
 * @updated 2026-11-25T03:15:00+08:00
 */
import type { DesktopGitBridge } from '@shared/desktop-git';

export function desktopGitBridge(): DesktopGitBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.atelierGit;
}

export const getDesktopGitBridge = desktopGitBridge;
