/**
 * @file 验证开发窗口关闭后可重新启动。
 * @implementation 用隔离的 Electron profile 验证重复启动提示、锁归属、正常关闭以及同配置重开。
 * @updated 2026-12-08T12:00:00+00:00
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import { defaultDesktopUiNotifications } from '../shared/desktop-ui-notifications.js';

const root = await mkdtemp(join(tmpdir(), 'atelier-dev-close-'));
const profile = join(root, 'profile');
const data = join(root, 'data');
const lock = join(data, 'server.lock');
await mkdir(profile);
await writeFile(
  join(profile, 'ui-notifications.json'),
  JSON.stringify({
    formatVersion: 1,
    notifications: { ...defaultDesktopUiNotifications, minimizeToTrayOnClose: true },
  }),
);
const executable = resolve('node_modules/electron/dist/electron');
const args = [resolve('dist/desktop/main.mjs'), '--disable-gpu', `--user-data-dir=${profile}`];
if (process.env.WAYLAND_DISPLAY) args.push('--ozone-platform=wayland');
const env = {
  ...process.env,
  ATELIER_DATA_DIR: data,
  ATELIER_PORT: '0',
  ATELIER_MAGPIE_URL: '',
  ATELIER_GATEWAY: 'http://127.0.0.1:1',
  ATELIER_DEV_LAUNCH: '1',
};
async function launch() {
  return _electron.launch({ executablePath: executable, args, env, timeout: 15_000 });
}
try {
  const first = await launch();
  try {
    const page = await first.firstWindow();
    await page.getByRole('dialog', { name: '绑定项目目录' }).waitFor();
    const initial = await readFile(lock, 'utf8');
    const duplicate = await promisify(execFile)(executable, args, { env, timeout: 5_000 });
    assert.match(duplicate.stderr, /An Atelier instance is already running/u);
    assert.equal(await readFile(lock, 'utf8'), initial);
    const closed = first.waitForEvent('close', { timeout: 4000 });
    await first.evaluate(({ BrowserWindow }) => {
      setTimeout(() => BrowserWindow.getAllWindows()[0]?.close(), 15);
    });
    await closed;
    await assert.rejects(access(lock), { code: 'ENOENT' });
    const next = await launch();
    try {
      await (await next.firstWindow()).locator('.react-workspace').waitFor({ timeout: 10_000 });
      assert.notEqual(await readFile(lock, 'utf8'), initial);
    } finally {
      await next.close();
    }
  } finally {
    await first.close().catch(() => {});
  }
  console.log('Development window close released the runtime and reopened with a new PID.');
} finally {
  await rm(root, { recursive: true, force: true });
}
