/**
 * @file 将原生网页中的工作台快捷键发给可信 renderer。
 * @implementation 按主文档持有当前注册，匹配时交还焦点并截住同一按键的重复和释放事件。
 * @updated 2026-11-26T21:40:00+08:00
 */
import {
  ipcMain,
  type BrowserWindow,
  type Event,
  type Input,
  type WebContentsDidStartNavigationEventParams,
  type WebFrameMain,
} from 'electron';
import {
  desktopShortcutChannels,
  desktopShortcutCommandSchema,
  desktopShortcutRegistrationSchema,
  desktopShortcutUpdateResultSchema,
  type DesktopShortcutRegistration,
} from '../shared/desktop-shortcuts.js';
import { matchShortcut, type ShortcutPlatform } from '../shared/shortcuts.js';

interface ShortcutHost {
  getWindow(): BrowserWindow | undefined;
  getOrigin(): string | undefined;
  isStopping(): boolean;
}

export function createDesktopShortcuts(host: ShortcutHost) {
  const platform: ShortcutPlatform = process.platform === 'darwin' ? 'mac' : 'other';
  const heldCodes = new Set<string>();
  let documentFrame: WebFrameMain | undefined;
  let registration: DesktopShortcutRegistration | undefined;

  function trustedWindow(): BrowserWindow | undefined {
    const owner = host.getWindow();
    const origin = host.getOrigin();
    if (
      host.isStopping() ||
      !origin ||
      !owner ||
      owner.isDestroyed() ||
      owner.webContents.isDestroyed() ||
      !documentFrame ||
      owner.webContents.mainFrame !== documentFrame ||
      documentFrame.origin !== origin
    )
      return undefined;
    return owner;
  }

  function clearDocument(): void {
    documentFrame = undefined;
    registration = undefined;
    heldCodes.clear();
  }

  function suppressHeld(event: Event, input: Input): boolean {
    if (!heldCodes.has(input.code)) return false;
    if (input.type === 'keyUp') heldCodes.delete(input.code);
    else if (input.type === 'keyDown' && !input.isAutoRepeat) {
      heldCodes.delete(input.code);
      return false;
    }
    event.preventDefault();
    return true;
  }

  function attachWindow(owner: BrowserWindow): () => void {
    clearDocument();
    const contents = owner.webContents;
    const starting = (event: Event<WebContentsDidStartNavigationEventParams>) => {
      if (event.isMainFrame && !event.isSameDocument) clearDocument();
    };
    const navigated = () => {
      documentFrame = contents.mainFrame;
    };
    const ownerInput = (event: Event, input: Input) => suppressHeld(event, input);
    contents.on('did-start-navigation', starting);
    contents.on('did-navigate', navigated);
    contents.on('before-input-event', ownerInput);
    contents.once('destroyed', clearDocument);
    return () => {
      clearDocument();
      if (contents.isDestroyed()) return;
      contents.off('did-start-navigation', starting);
      contents.off('did-navigate', navigated);
      contents.off('before-input-event', ownerInput);
      contents.off('destroyed', clearDocument);
    };
  }

  function bindIpc(): () => void {
    ipcMain.handle(desktopShortcutChannels.update, (event, value: unknown) => {
      const owner = trustedWindow();
      if (!owner || event.sender !== owner.webContents || event.senderFrame !== documentFrame)
        throw new Error('Untrusted shortcut registration.');
      const parsed = desktopShortcutRegistrationSchema.parse(value);
      registration = parsed.bindings.length ? parsed : undefined;
      return desktopShortcutUpdateResultSchema.parse(undefined);
    });
    return () => ipcMain.removeHandler(desktopShortcutChannels.update);
  }

  function handleGuestInput(event: Event, input: Input): void {
    const owner = trustedWindow();
    if (!owner?.isFocused() || suppressHeld(event, input) || !registration) return;
    // Electron does not expose the AltGraph modifier on Input.
    if (input.type !== 'keyDown' || (input.control && input.alt)) return;
    const key = {
      code: input.code,
      key: input.key,
      ctrlKey: input.control,
      metaKey: input.meta,
      altKey: input.alt,
      shiftKey: input.shift,
      repeat: input.isAutoRepeat,
      isComposing: input.isComposing,
    };
    const matched = registration.bindings.find(({ binding }) =>
      matchShortcut(key, binding, platform),
    );
    if (!matched) return;
    const command = desktopShortcutCommandSchema.parse({
      revision: registration.revision,
      commandId: matched.commandId,
    });
    event.preventDefault();
    heldCodes.add(input.code);
    owner.webContents.focus();
    owner.webContents.send(desktopShortcutChannels.command, command);
  }

  return { attachWindow, bindIpc, handleGuestInput };
}
