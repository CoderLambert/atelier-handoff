/**
 * @file 定义桌面系统托盘关闭拦截与常驻判定策略。
 * @implementation 保持纯函数与内嵌 32x32 图标数据无 Electron 运行时依赖，便于单元测试直接校验。
 * @updated 2026-11-27T23:50:00+08:00
 */

export const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABSElEQVR42mNgGGxAzcZUAYj7gfg8EP+nEj4PNVOBkOUJQPyeihajY5DZCfgs/08nnIAt2N/T0QHvUaIDGj//6Yz7kR1wfgAccB7ZAf8HApPtgMbuuv9fP9xBwSAxujng9q3jGA4AidHFAVGZ8RiWwzBIjuYOWL5mLk4HgORo6gBjd3sUC7fsWPH/3Lm9KGIgNTRzAHriSy/JxBAjJTGS7ADkxPfi6SWwmEOQF9mJkSQHoCe+WQsnw+XQo4HYxEiSA0DxjWwJyNKDhzeBMXq2BKmlqgPQg5kYDNJDNQf0Tesg2QEgPVRzALaSjxAmJjES5QBQVkOPe2LKCFg2pdgB6IkPXz5HV0soMRJ0ALbEhy9xlTSUkKSeoAN840LAiQmGCZVyoGhAVg/CIDOoXh3TokEy4E2yAW+UDmyzfMA7JoOiazYoOqcDAQBhk4Bb8HUoZQAAAABJRU5ErkJggg==';

export interface TrayClosePolicyInput {
  stopping: boolean;
  quitting: boolean;
  trayAvailable: boolean;
  minimizeToTrayOnClose: boolean;
}

export function shouldHideWindowOnClose(input: TrayClosePolicyInput): boolean {
  if (input.stopping || input.quitting) return false;
  return input.trayAvailable && input.minimizeToTrayOnClose;
}

export function shouldKeepAliveWhenWindowsClosed(input: TrayClosePolicyInput): boolean {
  return shouldHideWindowOnClose(input);
}
