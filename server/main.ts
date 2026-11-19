/**
 * @file 启动和关闭工作台服务。
 * @implementation 管理数据目录锁、本地监听、桌面就绪通知及退出清理。
 * @updated 2026-11-20T02:00+08:00
 */
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { desktopBrowserEnabled } from './desktop-browser.js';
import {
  desktopBrowserProtocolVersion,
  desktopBrowserReadySchema,
} from '../shared/desktop-browser.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = resolve(process.env.ATELIER_DATA_DIR || join(root, '.data'));
const desktopIpc = desktopBrowserEnabled();
const portSetting = process.env.ATELIER_PORT ?? '4317';
const port = Number(portSetting);
if (!/^(0|[1-9]\d{0,4})$/.test(portSetting) || port > 65535 || (port === 0 && !desktopIpc))
  throw new Error('ATELIER_PORT must be a valid port; 0 requires desktop IPC.');
await mkdir(data, { recursive: true, mode: 0o700 });
const lockFile = join(data, 'server.lock');
async function lock(): Promise<void> {
  try {
    const file = await open(lockFile, 'wx', 0o600);
    await file.writeFile(String(process.pid));
    await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockFile, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1)
      throw new Error('Invalid server.lock; inspect the data directory before starting.');
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('This data directory is already in use by another atelier server.');
    await unlink(lockFile);
    await lock();
  }
}
await lock();
let running: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  const app = await createApp({ root, data });
  running = app;
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', resolve);
  });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
  if (desktopIpc) {
    const ready = desktopBrowserReadySchema.parse({
      type: 'desktop-browser-ready',
      protocolVersion: desktopBrowserProtocolVersion,
      port: address.port,
    });
    await new Promise<void>((resolve, reject) => {
      const send = process.send;
      if (!send || !process.connected) {
        reject(new Error('Desktop IPC disconnected before readiness.'));
        return;
      }
      send.call(process, ready, (error: Error | null) => (error ? reject(error) : resolve()));
    });
  }
  console.log(`atelier ready: http://127.0.0.1:${address.port}`);
  console.log(`Private data: ${data}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('Stopping atelier and active SDK runs…');
    try {
      await app.close();
    } finally {
      await unlink(lockFile).catch(() => {});
    }
  };
  process.on('SIGINT', () => {
    void stop().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void stop().then(() => process.exit(0));
  });
  if (desktopIpc)
    process.once('disconnect', () => {
      void stop().then(() => process.exit(0));
    });
} catch (error) {
  try {
    await running?.close();
  } catch {
    console.error('工作台服务启动失败后未能完整清理。');
  } finally {
    await unlink(lockFile).catch(() => {});
  }
  throw error;
}
