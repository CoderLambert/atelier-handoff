/**
 * @file 管理全局通知与提示音偏好、播放服务及窗口唤醒。
 * @implementation 优先使用桌面 profile IPC 桥接持久化，在 SSE 接收到 run.finished 时自动裁决提示音和窗口焦点。
 * @updated 2026-11-23T18:25:00+08:00
 */
import { useEffect, useState } from 'react';
import type { RunStatus } from '@shared/types';
import {
  defaultDesktopUiNotifications,
  resolveDesktopUiNotifications,
  type DesktopUiNotifications,
  type DesktopUiNotificationsBridge,
  type SoundTheme,
} from '@shared/desktop-ui-notifications';
import { soundChime } from './sound-chime';

const STORAGE_KEY = 'atelier-ui-notifications-v1';

let inMemoryNotifications: DesktopUiNotifications = defaultDesktopUiNotifications;
const subscribers = new Set<(notifications: DesktopUiNotifications) => void>();

function desktopBridge(): DesktopUiNotificationsBridge | undefined {
  return typeof window !== 'undefined' ? window.atelierUiNotifications : undefined;
}

function readLocalBackup(): DesktopUiNotifications {
  if (typeof window === 'undefined') return defaultDesktopUiNotifications;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return resolveDesktopUiNotifications(JSON.parse(raw));
  } catch {
    // Ignore storage parse failure
  }
  return defaultDesktopUiNotifications;
}

function writeLocalBackup(notifications: DesktopUiNotifications): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
  } catch {
    // Ignore storage quota failure
  }
}

export function initializeUiNotificationsSync(): DesktopUiNotifications {
  inMemoryNotifications = readLocalBackup();
  return inMemoryNotifications;
}

export async function initializeUiNotifications(): Promise<DesktopUiNotifications> {
  const bridge = desktopBridge();
  if (bridge) {
    try {
      const persisted = await bridge.get();
      inMemoryNotifications = resolveDesktopUiNotifications(persisted);
      writeLocalBackup(inMemoryNotifications);
      subscribers.forEach((callback) => callback(inMemoryNotifications));
      return inMemoryNotifications;
    } catch {
      // Fall through to local backup
    }
  }
  inMemoryNotifications = readLocalBackup();
  subscribers.forEach((callback) => callback(inMemoryNotifications));
  return inMemoryNotifications;
}

export function getUiNotifications(): DesktopUiNotifications {
  return inMemoryNotifications;
}

export function setUiNotifications(patch: Partial<DesktopUiNotifications>): DesktopUiNotifications {
  const next = resolveDesktopUiNotifications({
    ...inMemoryNotifications,
    ...patch,
  });
  inMemoryNotifications = next;
  writeLocalBackup(next);
  subscribers.forEach((callback) => callback(next));
  const bridge = desktopBridge();
  if (bridge) {
    void bridge.set(next).catch(() => undefined);
  }
  return next;
}

export function playTestSound(theme?: SoundTheme): void {
  const chosenTheme = theme ?? inMemoryNotifications.soundTheme;
  soundChime.playCompletionChime(chosenTheme, inMemoryNotifications.volume);
}

export function notifyRunFinished(status?: RunStatus, sessionId?: string): void {
  const config = inMemoryNotifications;

  if (status === 'completed' && config.completionSound) {
    soundChime.playCompletionChime(config.soundTheme, config.volume);
  } else if ((status === 'failed' || status === 'interrupted') && config.failureSound) {
    soundChime.playFailureChime(config.volume);
  }

  if (config.focusOnCompletion) {
    const bridge = desktopBridge();
    if (bridge) {
      void bridge.focusWindow().catch(() => undefined);
    }
    if (typeof window !== 'undefined') {
      window.focus();
      window.dispatchEvent(
        new CustomEvent('atelier:run-finished', {
          detail: { sessionId, status },
        }),
      );
    }
  }
}

export function useUiNotifications() {
  const [notifications, setNotifications] = useState<DesktopUiNotifications>(inMemoryNotifications);

  useEffect(() => {
    setNotifications(inMemoryNotifications);
    subscribers.add(setNotifications);
    return () => {
      subscribers.delete(setNotifications);
    };
  }, []);

  return {
    notifications,
    setNotifications,
    updateNotifications: setUiNotifications,
    playTestSound,
  };
}
