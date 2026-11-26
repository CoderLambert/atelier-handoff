/**
 * @file 管理快捷操作的按键生命周期和浮层导航。
 * @implementation 保留已消费键到释放，隔离输入法收尾，并从可用命令和已保存配置解析单键导航。
 * @updated 2026-11-26T22:00:00+08:00
 */
import {
  getNavigationKey,
  type ShortcutKeyInput,
  type ShortcutPreferences,
} from '@shared/shortcuts';

interface AvailableCommand {
  id: string;
  available: boolean;
}

export function createShortcutKeyGuard() {
  const consumed = new Set<string>();
  let composing = false;
  let compositionUntil = 0;
  return {
    consume(code: string) {
      consumed.add(code);
    },
    release(code: string) {
      return consumed.delete(code);
    },
    suppresses(input: ShortcutKeyInput) {
      if (!input.repeat) {
        // A native surface can receive keyup after this renderer lost focus.
        consumed.delete(input.code);
        return false;
      }
      return consumed.has(input.code);
    },
    accepts(input: ShortcutKeyInput, now: number) {
      return (
        !composing &&
        now >= compositionUntil &&
        !input.isComposing &&
        input.keyCode !== 229 &&
        input.key !== 'Process' &&
        input.key !== 'Dead' &&
        !input.altGraph &&
        !input.repeat &&
        !input.defaultPrevented
      );
    },
    compositionStart() {
      composing = true;
    },
    compositionEnd(now: number) {
      composing = false;
      compositionUntil = now + 80;
    },
    reset() {
      consumed.clear();
      composing = false;
      compositionUntil = 0;
    },
  };
}

export function navigationCommand(
  input: ShortcutKeyInput,
  preferences: ShortcutPreferences,
  commands: readonly AvailableCommand[],
): string | undefined {
  if (
    !preferences.enabled ||
    input.ctrlKey ||
    input.metaKey ||
    input.altKey ||
    input.shiftKey ||
    input.isComposing ||
    input.keyCode === 229 ||
    input.altGraph ||
    input.repeat ||
    input.defaultPrevented ||
    input.key.length !== 1
  )
    return undefined;
  const key = input.key.toUpperCase();
  return commands.find(
    (command) => command.available && getNavigationKey(preferences, command.id) === key,
  )?.id;
}

export function nextAvailableCommand(
  commands: readonly AvailableCommand[],
  selected: string | undefined,
  direction: 1 | -1,
): string | undefined {
  const available = commands.filter((command) => command.available);
  if (available.length === 0) return undefined;
  const index = available.findIndex((command) => command.id === selected);
  const next = index < 0 ? (direction === 1 ? 0 : available.length - 1) : index + direction;
  return available[(next + available.length) % available.length]?.id;
}
