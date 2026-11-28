/**
 * @file 启动和关闭工作台服务。
 * @implementation 配对桌面宿主并独占数据目录，传递 RTK 启动参数，响应开发重启探测，统一释放运行时资源。
 * @updated 2026-12-08T12:00:00+00:00
 */
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { clearRtkEnvironment } from '../shared/builtin-rtk.js';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { acquireDataOwner, DataOwnerError } from './data-owner.js';
import { desktopBrowserEnabled } from './desktop-browser.js';
import { receiveDesktopHost, sendDesktopHost } from './desktop-host.js';
import {
  developmentRestartProbe,
  developmentRestartResult,
} from '../shared/desktop-development-restart.js';
import { desktopHostDeadlines, desktopHostSystemResumeSchema } from '../shared/desktop-host.js';

// Startup argv is supplied by the private desktop supervisor. Environment files
// and inherited shell variables cannot select RTK resources or its writable state.
const { values: startup } = parseArgs({
  options: { 'rtk-binary': { type: 'string' } },
  strict: true,
  allowPositionals: false,
});
clearRtkEnvironment(process.env);
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
  const rtkBinary = startup['rtk-binary'];
  if (rtkBinary !== undefined && (!host || !isAbsolute(rtkBinary)))
    throw new Error('RTK resource requires an absolute path from the private desktop host.');
  if (!/^(0|[1-9]\d{0,4})$/.test(portSetting) || port > 65535 || (port === 0 && !host))
    throw new Error('ATELIER_PORT must be a valid port; 0 requires desktop IPC.');
  release = acquireDataOwner(data);
  const app = await createApp({
    root,
    data,
    rtkBinary,
    desktopPairing: host?.pairing,
    nativeExecution:
      Boolean(host) && process.platform === 'linux' && process.env.ATELIER_NATIVE_EXECUTION !== '0',
    magpie: process.env.ATELIER_MAGPIE_URL ?? 'http://127.0.0.1:3425',
  });
  running = app;
  process.once('SIGINT', exit);
  process.once('SIGTERM', exit);
  if (host) {
    process.once('disconnect', exit);
    let restartReserved = false;
    process.on('message', (message: unknown) => {
      const restart = developmentRestartProbe.safeParse(message);
      if (restart.success && process.env.ATELIER_DEV_LAUNCH === '1' && process.connected) {
        process.send?.(
          developmentRestartResult.parse({
            type: 'atelier-dev:restart-result',
            id: restart.data.id,
            ready: (restartReserved ||= app.prepareDevelopmentRestart()),
          }),
          () => {},
        );
      }
      if (desktopHostSystemResumeSchema.safeParse(message).success) {
        app.scheduleScheduler.wakeFromSuspend();
      }
    });
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
