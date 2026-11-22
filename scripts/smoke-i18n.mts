/**
 * @file 验证 Electron 的界面语言切换与持久化。
 * @implementation 以隔离 profile 启动，检查页面、磁盘和运行时故障恢复窗口的语言。
 * @updated 2026-11-22T22:42:37+08:00
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication } from 'playwright-core';
import { desktopUiLanguagePreferenceSchema } from '../shared/desktop-ui-language.js';
import { until } from './p1-smoke/contracts.mjs';

const args = process.argv.slice(2);
const binary = args[0];
assert.ok(binary, 'Usage: tsx scripts/smoke-i18n.mts <Electron executable> [development entry]');
const executablePath = resolve(binary);
const entry = args[1];
const directory = await mkdtemp(
  join(
    process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : resolve('.local'),
    'i18n-smoke-',
  ),
);
const profile = join(directory, 'profile');
const data = join(directory, 'data');
const gateway = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end('{}');
});
gateway.listen(0, '127.0.0.1');
await new Promise<void>((ready) => gateway.once('listening', ready));
const address = gateway.address();
assert.ok(address && typeof address !== 'string');
const env = {
  ...process.env,
  ATELIER_DATA_DIR: data,
  ATELIER_PORT: '0',
  ATELIER_GATEWAY: `http://127.0.0.1:${address.port}`,
  ATELIER_GATEWAY_TOKEN: 'i18n-fixture',
  ATELIER_MODEL: 'fixture-model',
};

let app: ElectronApplication | undefined;
async function launch() {
  app = await _electron.launch({
    executablePath,
    args: [
      ...(entry ? [resolve(entry)] : []),
      `--user-data-dir=${profile}`,
      ...(process.env.ATELIER_SMOKE_OZONE
        ? [`--ozone-platform=${process.env.ATELIER_SMOKE_OZONE}`]
        : []),
    ],
    env,
    timeout: 25_000,
  });
  const page = await app.firstWindow();
  await page.waitForURL('http://127.0.0.1:*/**');
  return { app, page, origin: new URL(page.url()).origin };
}

try {
  const first = await launch();
  await first.page.goto(`${first.origin}/#/settings/models`);
  await first.page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  assert.equal(await first.page.locator('html').getAttribute('lang'), 'zh-CN');
  await first.page.getByRole('combobox', { name: '界面语言', exact: true }).click();
  await first.page.getByRole('option', { name: 'English', exact: true }).click();
  await first.page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await first.page.locator('html').getAttribute('lang'), 'en');
  assert.match(await first.page.title(), /The decisions are yours/u);
  const stored: unknown = JSON.parse(await readFile(join(profile, 'ui-language.json'), 'utf8'));
  assert.equal(desktopUiLanguagePreferenceSchema.parse(stored).locale, 'en');
  await first.app.close();

  const reopened = await launch();
  await reopened.page.goto(`${reopened.origin}/#/settings/models`);
  await reopened.page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await reopened.page.locator('html').getAttribute('lang'), 'en');

  const recovery = await reopened.app.evaluateHandle(({ dialog }) => {
    const captured: { buttons?: string[]; message?: string; detail?: string } = {};
    dialog.showMessageBox = async (...params: unknown[]) => {
      const options = params.at(-1);
      if (options && typeof options === 'object') Object.assign(captured, options);
      return { response: 0, checkboxChecked: false };
    };
    return captured;
  });
  const pid = Number(await readFile(join(data, 'server.lock'), 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  process.kill(pid, 'SIGKILL');
  await until(
    async () => {
      const dialog = await recovery.jsonValue();
      return dialog.buttons?.some((button) => /restart/i.test(button)) ?? false;
    },
    20_000,
    'English recovery dialog',
  );
  await reopened.page.waitForURL(
    (url) => url.origin !== reopened.origin && url.protocol === 'http:',
  );
  await reopened.page.goto(`${new URL(reopened.page.url()).origin}/#/settings/models`);
  await reopened.page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await reopened.page.locator('html').getAttribute('lang'), 'en');
  console.log('Electron language switch, profile restart and English recovery passed.');
} finally {
  await app?.close().catch(() => undefined);
  gateway.closeAllConnections();
  await new Promise<void>((closed) => gateway.close(() => closed()));
  await rm(directory, { recursive: true, force: true });
}
