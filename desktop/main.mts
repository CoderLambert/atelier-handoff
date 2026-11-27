/**
 * @file 管理桌面应用、内置网关及原生操作入口的生命周期。
 * @implementation 装配窗口、快捷键与原生入口，管理内置 Shunt、运行时恢复和退出。按安装或开发资源布局向私有运行时传入固定 RTK 路径。
 * @updated 2026-11-27T22:00:00+08:00
 */
import { app, type BrowserWindow } from 'electron';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { importWorkspace } from './host/migration.mjs';
import { createNativeFileActions } from './host/files.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { RuntimeSupervisor } from './host/runtime.mjs';
import { rtkRelease } from '../shared/builtin-rtk.js';
import { ManagedShunt, type ManagedShuntConnection } from './host/managed-shunt.mjs';
import {
  bindPairing,
  createWindow,
  focusWindow,
  loadWindow,
  retryRuntime,
} from './host/window.mjs';
import { homedir } from 'node:os';
import { createBrowserController } from './browser/controller.mjs';
import { createDesktopShortcuts } from './shortcuts.mjs';
import {
  desktopBrowserCallSchema,
  desktopBrowserCancelSchema,
  desktopBrowserErrorCodeSchema,
  desktopBrowserProtocolVersion,
  desktopBrowserResultSchema,
  type DesktopBrowserResult,
} from '../shared/desktop-browser.js';
import { AppError } from '../shared/errors.js';
import { DesktopUiLanguagePreferences } from './host/ui-language.mjs';
import { bindUiLanguage } from './host/ui-language-ipc.mjs';
import { DesktopUiThemePreferences } from './host/ui-theme.mjs';
import { bindUiTheme } from './host/ui-theme-ipc.mjs';
import { DesktopUiNotificationsPreferences } from './host/ui-notifications.mjs';
import { bindUiNotifications } from './host/ui-notifications-ipc.mjs';
import { bindDesktopGit } from './host/git-ipc.mjs';
import { createTrustedSenderPredicate } from './host/trusted-ipc.mjs';
import { asDesktopHostError, DesktopHostError, desktopI18n } from './host/i18n.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// The development bundle lives in dist/desktop; source execution lives in desktop.
const root = app.isPackaged
  ? join(process.resourcesPath, 'runtime')
  : fileURLToPath(new URL(import.meta.url.endsWith('.mts') ? '../' : '../../', import.meta.url));
const dataHome = process.env.XDG_DATA_HOME;
const packagedData = join(
  process.platform === 'linux'
    ? dataHome && isAbsolute(dataHome)
      ? dataHome
      : join(homedir(), '.local/share')
    : app.getPath('appData'),
  'atelier',
);
const dataDir = process.env.ATELIER_DATA_DIR
  ? requireAbsolutePath(process.env.ATELIER_DATA_DIR, 'ATELIER_DATA_DIR')
  : app.isPackaged
    ? packagedData
    : join(root, '.data');

let origin: string | undefined;
let window: BrowserWindow | undefined;
let runtimeConnection: Awaited<ReturnType<RuntimeSupervisor['start']>> | undefined;
let stopping = false;
const windowHost = {
  getWindow: () => window,
  getOrigin: () => origin,
  isStopping: () => stopping,
};
const nativeFiles = createNativeFileActions(
  windowHost.getWindow,
  () => runtimeConnection,
  windowHost.isStopping,
);
const desktopShortcuts = createDesktopShortcuts(windowHost);
const browser = createBrowserController({
  ...windowHost,
  isTrustedSender: createTrustedSenderPredicate(
    windowHost.getWindow,
    windowHost.getOrigin,
    windowHost.isStopping,
  ),
  onShortcutInput: desktopShortcuts.handleGuestInput,
});

function requireAbsolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return value;
}

async function handleBrowserCall(child: ChildProcess, value: unknown): Promise<void> {
  if (!supervisor.owns(child) || stopping) return;
  const cancel = desktopBrowserCancelSchema.safeParse(value);
  if (cancel.success) {
    browser.cancel(cancel.data.id);
    return;
  }
  const request = desktopBrowserCallSchema.safeParse(value);
  if (!request.success) return;
  let result: DesktopBrowserResult;
  const header = {
    type: 'desktop-browser-result',
    protocolVersion: desktopBrowserProtocolVersion,
    id: request.data.id,
  } as const;
  try {
    result = desktopBrowserResultSchema.parse({
      ...header,
      ...(await browser.runTool(request.data)),
    });
  } catch (error) {
    result = desktopBrowserResultSchema.parse({
      ...header,
      error: error instanceof Error ? error.message : '浏览器操作失败。',
      errorCode: desktopBrowserErrorCodeSchema.safeParse(error instanceof AppError && error.code)
        .data,
    });
  }
  if (supervisor.owns(child) && child.connected && !stopping)
    child.send(result, (error) => {
      if (error && !stopping) console.error('浏览器响应发送失败。');
    });
}

const lifecycle = new AbortController();
const resources = app.isPackaged
  ? process.resourcesPath
  : join(root, 'dist', 'linux', 'atelier', 'resources');
const shuntBinary = join(resources, 'shunt', 'shunt');
// Only the application resource layout selects RTK. Runtime verifies the pinned
// executable and launcher before enabling the capability; no host PATH fallback.
const rtkBinary =
  process.platform === rtkRelease.platform && process.arch === rtkRelease.arch
    ? join(resources, rtkRelease.resourcePath)
    : undefined;
const managedShunt =
  process.platform === 'linux' && !process.env.ATELIER_GATEWAY && existsSync(shuntBinary)
    ? new ManagedShunt(shuntBinary, dataDir)
    : undefined;
let unbindPairing: (() => void) | undefined;
let unbindShortcutWindow: (() => void) | undefined;
let recovery: Promise<void> | undefined;
let quitting = false;
const supervisor = new RuntimeSupervisor(
  { packaged: app.isPackaged, root, dataDir, rtkBinary },
  (child, value) => {
    void handleBrowserCall(child, value).catch(() => console.error('浏览器操作失败。'));
  },
  (reason) => {
    void recover(reason);
  },
);

function clearRuntimeWindow(): void {
  origin = undefined;
  runtimeConnection = undefined;
  nativeFiles.reset();
  unbindPairing?.();
  unbindPairing = undefined;
  unbindShortcutWindow?.();
  unbindShortcutWindow = undefined;
  browser.reset();
  if (window && !window.isDestroyed()) window.hide();
}

async function start(): Promise<void> {
  if (stopping) return;
  let gateway: ManagedShuntConnection | undefined;
  try {
    gateway = await managedShunt?.start(lifecycle.signal);
  } catch {
    if (!stopping) console.error('内置 Shunt 启动失败。');
  }
  if (stopping) return;
  const connection = await supervisor.start(gateway);
  if (stopping) return;
  runtimeConnection = connection;
  origin = connection.origin;
  const owner =
    window && !window.isDestroyed()
      ? window
      : createWindow(join(here, 'preload.cjs'), () => origin, uiTheme.get());
  window = owner;
  owner.webContents.removeListener('render-process-gone', rendererGone);
  owner.webContents.on('render-process-gone', rendererGone);
  unbindPairing = bindPairing(owner, origin, connection.pairing);
  unbindShortcutWindow = desktopShortcuts.attachWindow(owner);
  await loadWindow(owner, origin);
  if (!supervisor.connected || stopping) throw new DesktopHostError('host.failure.disconnected');
  focusWindow(owner);
}

function rendererGone(): void {
  void recover(new DesktopHostError('host.failure.rendererGone'));
}

function recover(reason: DesktopHostError): Promise<void> {
  if (stopping) return Promise.resolve();
  return (recovery ??= (async () => {
    while (!stopping) {
      clearRuntimeWindow();
      await supervisor.stop();
      if (stopping) return;
      if (!(await retryRuntime(reason, lifecycle.signal))) {
        app.quit();
        return;
      }
      try {
        await start();
        if (origin || stopping) return;
        reason = new DesktopHostError('host.failure.disconnected');
      } catch (error) {
        reason = asDesktopHostError(error);
      }
    }
  })()
    .catch(() => app.quit())
    .finally(() => {
      recovery = undefined;
    }));
}

app.setName('atelier');
// Set the profile before taking the lock: packaged and development instances must
// not share Chromium partitions, and disposable smoke profiles must stay isolated.
const requestedProfile = app.commandLine.getSwitchValue('user-data-dir');
const migrationMode = app.commandLine.hasSwitch('import-data');
// The wizard reads the destination profile's language without opening its Chromium data.
const regularProfile = requestedProfile
  ? requireAbsolutePath(requestedProfile, '--user-data-dir')
  : app.isPackaged || process.env.ATELIER_DATA_DIR
    ? join(dataDir, 'desktop-profile')
    : app.getPath('userData');
const temporaryProfile = migrationMode
  ? mkdtempSync(join(app.getPath('temp'), 'atelier-migration-profile-'))
  : undefined;
if (temporaryProfile || requestedProfile || app.isPackaged || process.env.ATELIER_DATA_DIR) {
  const profile = temporaryProfile ?? regularProfile;
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}
if (temporaryProfile)
  app.once('will-quit', () => rmSync(temporaryProfile, { recursive: true, force: true }));
const uiLanguage = new DesktopUiLanguagePreferences(regularProfile, (locale) =>
  desktopI18n.changeLanguage(locale),
);
const uiTheme = new DesktopUiThemePreferences(regularProfile);
const uiNotifications = new DesktopUiNotificationsPreferences(regularProfile);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (origin && window) focusWindow(window);
  });
  void app
    .whenReady()
    .then(async () => {
      await Promise.all([uiLanguage.load(), uiTheme.load(), uiNotifications.load()]);
      if (!migrationMode) {
        const unbindUiLanguage = bindUiLanguage(
          uiLanguage,
          () => window,
          () => runtimeConnection,
          () => stopping,
        );
        const unbindUiTheme = bindUiTheme(
          uiTheme,
          () => window,
          () => runtimeConnection,
          () => stopping,
        );
        const unbindUiNotifications = bindUiNotifications(
          uiNotifications,
          () => window,
          () => runtimeConnection,
          () => stopping,
        );
        const unbindDesktopGit = bindDesktopGit(
          () => window,
          () => runtimeConnection,
          () => stopping,
        );
        const unbindDesktopShortcutIpc = desktopShortcuts.bindIpc();
        const unbindBrowserIpc = browser.bindIpc();
        app.once('will-quit', () => {
          unbindUiLanguage();
          unbindUiTheme();
          unbindUiNotifications();
          unbindDesktopGit();
          unbindDesktopShortcutIpc();
          unbindBrowserIpc();
        });
        return start();
      }
      if (
        await importWorkspace({
          runtimeRoot: root,
          dataDir,
          packaged: app.isPackaged,
          signal: lifecycle.signal,
        })
      ) {
        app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== '--import-data') });
      }
      app.quit();
    })
    .catch((error: unknown) => {
      if (migrationMode) {
        console.error('无法打开工作台迁入向导。');
        app.quit();
        return;
      }
      void recover(asDesktopHostError(error));
    });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  if (stopping) return;
  stopping = true;
  lifecycle.abort();
  clearRuntimeWindow();
  void supervisor
    .stop()
    .finally(() => managedShunt?.stop())
    .finally(() => {
      quitting = true;
      app.quit();
    });
});
