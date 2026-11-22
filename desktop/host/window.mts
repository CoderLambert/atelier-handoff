/**
 * @file 管理工作台窗口、配对请求和原生恢复入口。
 * @implementation 限制可信页面导航与 HTTP 配对范围，通过系统对话框提供恢复操作。
 * @updated 2026-11-20T02:00+08:00
 */
import { BrowserWindow, dialog } from 'electron';
import { desktopHostDeadlines, desktopPairingHeader } from '../../shared/desktop-host.js';
import { desktopT, DesktopHostError, diagnosticText } from './i18n.mjs';

export function createWindow(preload: string, getOrigin: () => string | undefined): BrowserWindow {
  const owner = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    title: 'atelier',
    webPreferences: {
      preload,
      partition: 'atelier-workbench',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const wc = owner.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== getOrigin()) event.preventDefault();
  });
  wc.on('will-redirect', (event, url) => {
    if (new URL(url).origin !== getOrigin()) event.preventDefault();
  });
  return owner;
}

export function bindPairing(owner: BrowserWindow, origin: string, pairing: string): () => void {
  const wc = owner.webContents;
  const request = wc.session.webRequest;
  request.onBeforeSendHeaders({ urls: ['http://127.0.0.1/*'] }, (details, callback) => {
    const url = new URL(details.url);
    if (
      url.origin !== origin ||
      !url.pathname.startsWith('/api/') ||
      wc.isDestroyed() ||
      details.webContentsId !== wc.id ||
      wc.mainFrame.origin !== origin ||
      (details.initiatorOrigin !== undefined && details.initiatorOrigin !== origin) ||
      (details.frame !== wc.mainFrame &&
        !(
          details.resourceType === 'subFrame' &&
          details.initiatorOrigin === origin &&
          details.method === 'GET' &&
          /^\/api\/artifacts\/[a-f0-9-]{36}\/preview$/.test(url.pathname)
        ))
    ) {
      callback({});
      return;
    }
    callback({ requestHeaders: { ...details.requestHeaders, [desktopPairingHeader]: pairing } });
  });
  return () => request.onBeforeSendHeaders(null);
}

export async function loadWindow(owner: BrowserWindow, origin: string): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      owner.loadURL(origin),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          reject(new DesktopHostError('host.failure.windowTimeout'));
        }, desktopHostDeadlines.window);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

export function focusWindow(owner: BrowserWindow): void {
  if (owner.isDestroyed()) return;
  if (owner.isMinimized()) owner.restore();
  owner.show();
  owner.focus();
}

export async function retryRuntime(
  reason: DesktopHostError,
  signal: AbortSignal,
): Promise<boolean> {
  const diagnostic = diagnosticText(reason.cause);
  const detail = desktopT('host.recovery.detail');
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'atelier',
    message: desktopT(reason.key),
    detail: diagnostic
      ? `${detail}\n\n${desktopT('host.recovery.diagnostic', { diagnostic })}`
      : detail,
    buttons: [desktopT('host.recovery.restart'), desktopT('host.action.exit')],
    defaultId: 0,
    cancelId: 1,
    signal,
  });
  return result.response === 0 && !signal.aborted;
}
