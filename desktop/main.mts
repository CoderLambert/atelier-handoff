/**
 * @file 管理桌面应用生命周期、原生浏览器与文件操作入口。
 * @implementation 装配运行时监督、窗口、浏览器和原生文件入口，处理数据迁入、连接恢复与退出。
 * @updated 2026-11-20T03:34:05+08:00
 */
import { app, type BrowserWindow } from 'electron';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { importWorkspace } from './host/migration.mjs';
import { createNativeFileActions } from './host/files.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { RuntimeSupervisor } from './host/runtime.mjs';
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
import {
  desktopBrowserCallSchema,
  desktopBrowserCancelSchema,
  desktopBrowserProtocolVersion,
  desktopBrowserResultSchema,
  type DesktopBrowserResult,
} from '../shared/desktop-browser.js';

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
const nativeFiles = createNativeFileActions(
  () => window,
  () => runtimeConnection,
);
let stopping = false;
const browser = createBrowserController({
  getWindow: () => window,
  getOrigin: () => origin,
  isStopping: () => stopping,
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
    });
  }
  if (supervisor.owns(child) && child.connected && !stopping)
    child.send(result, (error) => {
      if (error && !stopping) console.error('浏览器响应发送失败。');
    });
}

const lifecycle = new AbortController();
const shuntBinary = join(process.resourcesPath, 'shunt', 'shunt');
const managedShunt =
  app.isPackaged &&
  process.platform === 'linux' &&
  !process.env.ATELIER_GATEWAY &&
  existsSync(shuntBinary)
    ? new ManagedShunt(shuntBinary, dataDir)
    : undefined;
let unbindPairing: (() => void) | undefined;
let recovery: Promise<void> | undefined;
let quitting = false;
const supervisor = new RuntimeSupervisor(
  { packaged: app.isPackaged, root, dataDir },
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
      : createWindow(join(here, 'preload.cjs'), () => origin);
  window = owner;
  owner.webContents.removeListener('render-process-gone', rendererGone);
  owner.webContents.on('render-process-gone', rendererGone);
  unbindPairing = bindPairing(owner, origin, connection.pairing);
  await loadWindow(owner, origin);
  if (!supervisor.connected || stopping) throw new Error('工作台服务连接已断开。');
  focusWindow(owner);
}

function rendererGone(): void {
  void recover('工作台窗口意外退出。');
}

function recover(reason: string): Promise<void> {
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
        reason = '工作台服务连接已断开。';
      } catch (error) {
        reason = error instanceof Error ? error.message : '工作台启动失败。';
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
const temporaryProfile = migrationMode
  ? mkdtempSync(join(app.getPath('temp'), 'atelier-migration-profile-'))
  : undefined;
if (temporaryProfile || requestedProfile || app.isPackaged || process.env.ATELIER_DATA_DIR) {
  const profile =
    temporaryProfile ??
    (requestedProfile
      ? requireAbsolutePath(requestedProfile, '--user-data-dir')
      : join(dataDir, 'desktop-profile'));
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}
if (temporaryProfile)
  app.once('will-quit', () => rmSync(temporaryProfile, { recursive: true, force: true }));

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (origin && window) focusWindow(window);
  });
  void app
    .whenReady()
    .then(async () => {
      if (!migrationMode) return start();
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
      void recover(error instanceof Error ? error.message : '工作台启动失败。');
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
