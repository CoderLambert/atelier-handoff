/**
 * @file 启动和关闭工作台服务。
 * @implementation 配对桌面宿主，独占数据目录，本地监听并统一清理业务和持久化资源。
 * @updated 2026-11-20T02:00+08:00
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { acquireDataOwner, DataOwnerError } from './data-owner.js';
import { desktopBrowserEnabled } from './desktop-browser.js';
import { receiveDesktopHost, sendDesktopHost } from './desktop-host.js';
import { desktopHostDeadlines } from '../shared/desktop-host.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = process.env.ATELIER_DATA_DIR || join(root, '.data');
const desktopIpc = desktopBrowserEnabled();
if (process.env.ATELIER_DESKTOP_BROWSER === '1' && !desktopIpc)
  throw new Error('Desktop runtime requires a private IPC connection.');
const host = desktopIpc ? await receiveDesktopHost() : undefined;
const portSetting = process.env.ATELIER_PORT ?? (host ? '0' : '4317');
const port = Number(portSetting);
let release: (() => void) | undefined;
let running: Awaited<ReturnType<typeof createApp>> | undefined;
let stopping: Promise<void> | undefined;

function stop(): Promise<void> {
  return (stopping ??= (async () => {
    await running?.close();
    release?.();
  })());
}

function exit(): void {
  if (stopping) return;
  const timeout = setTimeout(() => {
    console.error('工作台服务关闭超时，未完成的运行将在重启时标记为中断。');
    // The desktop supervisor owns group termination while connected. After a lost host,
    // leave the SQLite recovery safely to the next startup and exit this runtime.
    process.exit(1);
  }, desktopHostDeadlines.stop);
  timeout.unref();
  void stop().then(
    () => process.exit(0),
    () => {
      console.error('工作台服务未能完整清理。');
      process.exit(1);
    },
  );
}

try {
  if (!/^(0|[1-9]\d{0,4})$/.test(portSetting) || port > 65535 || (port === 0 && !host))
    throw new Error('ATELIER_PORT must be a valid port; 0 requires desktop IPC.');
  release = acquireDataOwner(data);
  const app = await createApp({ root, data, desktopPairing: host?.pairing });
  running = app;
  process.once('SIGINT', exit);
  process.once('SIGTERM', exit);
  if (host) {
    process.once('disconnect', exit);
    if (!process.connected) throw new Error('Desktop IPC disconnected before startup.');
  }
  await new Promise<void>((resolve, reject) => {
    const bound = () => {
      app.server.off('error', failed);
      resolve();
    };
    const failed = (error: Error) => {
      app.server.off('listening', bound);
      reject(error);
    };
    app.server.once('error', failed);
    app.server.once('listening', bound);
    app.server.listen(port, '127.0.0.1');
  });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
  if (host)
    await sendDesktopHost({
      type: 'atelier-host:ready',
      protocolVersion: host.protocolVersion,
      generation: host.generation,
      port: address.port,
    });
  console.log(`atelier ready: http://127.0.0.1:${address.port}`);
  console.log(`Private data: ${data}`);
} catch (error) {
  if (host) {
    const code =
      error instanceof DataOwnerError
        ? error.code
        : (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? 'PORT_IN_USE'
          : 'STARTUP_FAILED';
    await sendDesktopHost({
      type: 'atelier-host:failed',
      protocolVersion: host.protocolVersion,
      generation: host.generation,
      code,
    }).catch(() => {});
  }
  try {
    await stop();
  } catch {
    console.error('工作台服务启动失败后未能完整清理。');
  }
  throw error;
}
