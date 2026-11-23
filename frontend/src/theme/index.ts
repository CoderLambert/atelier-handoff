/**
 * @file 管理工作台界面视觉主题（皮肤）与响应式切换。
 * @implementation 支持黑曜工作室、工坊经典、暖纸书卷、冰川冷白、晨曦蔷薇与深空墨夜等经典流行主题，通过桌面 Profile 与本地存储持久化，并同步根节点 dataset。
 * @updated 2026-11-23T14:48:00+08:00
 */
import { useCallback, useSyncExternalStore } from 'react';
import {
  allUiThemes,
  defaultUiTheme,
  resolveUiTheme,
  uiThemeSchema,
  type DesktopUiThemeBridge,
  type UiTheme,
} from '@shared/desktop-ui-theme';

export { allUiThemes, defaultUiTheme, resolveUiTheme, uiThemeSchema, type UiTheme };

export const uiThemeStorageKey = 'atelier.ui-theme.v1';

let currentTheme: UiTheme = defaultUiTheme;
const listeners = new Set<() => void>();

function desktopBridge(): DesktopUiThemeBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { atelierUiTheme?: DesktopUiThemeBridge }).atelierUiTheme;
}

async function withDeadline<T>(result: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('UI_THEME_READ_TIMEOUT')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): UiTheme {
  return currentTheme;
}

export function getUiTheme(): UiTheme {
  if (typeof window === 'undefined') return defaultUiTheme;
  try {
    return resolveUiTheme(localStorage.getItem(uiThemeStorageKey));
  } catch {
    return defaultUiTheme;
  }
}

export function applyTheme(theme: UiTheme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
  }
}

/**
 * 启动时同步应用当前主题（防止首屏闪屏）
 */
export function initializeUiThemeSync(): UiTheme {
  currentTheme = getUiTheme();
  applyTheme(currentTheme);
  return currentTheme;
}

/**
 * 异步初始化主题：优先从桌面 profile（解决 Electron 随机端口隔离问题）或本地存储加载
 */
export async function initializeUiTheme(): Promise<UiTheme> {
  initializeUiThemeSync();
  try {
    const desktop = desktopBridge();
    if (desktop) {
      const saved = resolveUiTheme(await withDeadline(desktop.get()));
      if (saved && saved !== currentTheme) {
        currentTheme = saved;
        try {
          localStorage.setItem(uiThemeStorageKey, currentTheme);
        } catch {
          // 忽略存储受限场景
        }
        applyTheme(currentTheme);
        notify();
      }
    }
  } catch {
    // 忽略无法读取桌面偏好时的错误，保留现有状态
  }
  return currentTheme;
}

export function setUiTheme(theme: UiTheme): void {
  currentTheme = resolveUiTheme(theme);
  try {
    localStorage.setItem(uiThemeStorageKey, currentTheme);
  } catch {
    // 忽略存储受限场景
  }
  applyTheme(currentTheme);
  notify();

  // 异步持久化到桌面 profile
  void (async () => {
    try {
      const desktop = desktopBridge();
      if (desktop) {
        await desktop.set(currentTheme);
      }
    } catch {
      // 忽略持久化失败
    }
  })();
}

export function useUiTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => defaultUiTheme);

  const setTheme = useCallback((next: UiTheme) => {
    setUiTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    const currentIndex = allUiThemes.indexOf(currentTheme);
    const nextIndex = (currentIndex + 1) % allUiThemes.length;
    const next = allUiThemes[nextIndex] ?? defaultUiTheme;
    setUiTheme(next);
  }, []);

  return { theme, setTheme, toggleTheme };
}
