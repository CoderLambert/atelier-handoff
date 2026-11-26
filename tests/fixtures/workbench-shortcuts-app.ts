/**
 * @file 为快捷键烟测启动隔离的真实桌面工作台与 Node 运行时。
 * @implementation 复用生产窗口、配对、浏览器和快捷键桥接，避开测试环境不支持的单实例锁。
 * @updated 2026-11-26T21:52:00+08:00
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { createBrowserController } from '../../desktop/browser/controller.mjs';
import { createNativeFileActions } from '../../desktop/host/files.mjs';
import { bindDesktopGit } from '../../desktop/host/git-ipc.mjs';
import { desktopI18n } from '../../desktop/host/i18n.mjs';
import { RuntimeSupervisor } from '../../desktop/host/runtime.mjs';
import { bindUiLanguage } from '../../desktop/host/ui-language-ipc.mjs';
import { DesktopUiLanguagePreferences } from '../../desktop/host/ui-language.mjs';
import { bindUiNotifications } from '../../desktop/host/ui-notifications-ipc.mjs';
import { DesktopUiNotificationsPreferences } from '../../desktop/host/ui-notifications.mjs';
import { bindUiTheme } from '../../desktop/host/ui-theme-ipc.mjs';
import { DesktopUiThemePreferences } from '../../desktop/host/ui-theme.mjs';
import { bindPairing, createWindow, focusWindow, loadWindow } from '../../desktop/host/window.mjs';
import { createDesktopShortcuts } from '../../desktop/shortcuts.mjs';
import {
  desktopBrowserCallSchema,
  desktopBrowserCancelSchema,
  desktopBrowserErrorCodeSchema,
  desktopBrowserProtocolVersion,
  desktopBrowserResultSchema,
} from '../../shared/desktop-browser.js';
import { AppError } from '../../shared/types.js';

const root = process.cwd();
const dataDir = process.env.ATELIER_DATA_DIR;
const profile = app.commandLine.getSwitchValue('user-data-dir');
assert.ok(
  dataDir && isAbsolute(dataDir),
  'The smoke fixture requires an isolated ATELIER_DATA_DIR.',
);
assert.ok(
  isAbsolute(profile) && profile !== dataDir,
  'The smoke fixture requires an isolated profile.',
);
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
app.setPath('sessionData', profile);

let owner: BrowserWindow | undefined;
let connection: Awaited<ReturnType<RuntimeSupervisor['start']>> | undefined;
let stopping: Promise<void> | undefined;
const cleanup: Array<() => void> = [];
const getWindow = () => owner;
const getConnection = () => connection;
const isStopping = () => Boolean(stopping);
const host = { getWindow, getOrigin: () => connection?.origin, isStopping };
const shortcuts = createDesktopShortcuts(host);
const browser = createBrowserController({ ...host, onShortcutInput: shortcuts.handleGuestInput });
const files = createNativeFileActions(getWindow, getConnection);
const uiLanguage = new DesktopUiLanguagePreferences(profile, (locale) =>
  desktopI18n.changeLanguage(locale),
);
const uiTheme = new DesktopUiThemePreferences(profile);
const uiNotifications = new DesktopUiNotificationsPreferences(profile);
const supervisor = new RuntimeSupervisor(
  { packaged: false, root, dataDir },
  (child, message) => {
    if (!supervisor.owns(child) || isStopping()) return;
    const cancel = desktopBrowserCancelSchema.safeParse(message);
    if (cancel.success) {
      browser.cancel(cancel.data.id);
      return;
    }
    const request = desktopBrowserCallSchema.safeParse(message);
    if (!request.success) return;
    const header = {
      type: 'desktop-browser-result',
      protocolVersion: desktopBrowserProtocolVersion,
      id: request.data.id,
    } as const;
    void browser
      .runTool(request.data)
      .then(
        (result) => desktopBrowserResultSchema.parse({ ...header, ...result }),
        (error: unknown) =>
          desktopBrowserResultSchema.parse({
            ...header,
            error: error instanceof Error ? error.message : 'Browser operation failed.',
            errorCode: desktopBrowserErrorCodeSchema.safeParse(
              error instanceof AppError && error.code,
            ).data,
          }),
      )
      .then((result) => {
        if (supervisor.owns(child) && child.connected) child.send(result);
      })
      .catch(fail);
  },
  fail,
);

function stop(): Promise<void> {
  return (stopping ??= Promise.resolve().then(async () => {
    connection = undefined;
    for (const dispose of cleanup.reverse()) dispose();
    browser.reset();
    files.reset();
    await supervisor.stop();
  }));
}

function fail(error: unknown): void {
  console.error(error);
  void stop().finally(() => app.exit(1));
}

void app
  .whenReady()
  .then(async () => {
    await Promise.all([uiLanguage.load(), uiTheme.load(), uiNotifications.load()]);
    cleanup.push(
      bindUiLanguage(uiLanguage, getWindow, getConnection, isStopping),
      bindUiTheme(uiTheme, getWindow, getConnection, isStopping),
      bindUiNotifications(uiNotifications, getWindow, getConnection, isStopping),
      bindDesktopGit(getWindow, getConnection, isStopping),
      shortcuts.bindIpc(),
    );
    connection = await supervisor.start();
    if (isStopping()) return;
    owner = createWindow(join(root, 'dist/desktop/preload.cjs'), host.getOrigin, uiTheme.get());
    cleanup.push(
      shortcuts.attachWindow(owner),
      bindPairing(owner, connection.origin, connection.pairing),
    );
    await loadWindow(owner, connection.origin);
    focusWindow(owner);
  })
  .catch(fail);

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  event.preventDefault();
  void stop().then(() => app.exit(0), fail);
});
