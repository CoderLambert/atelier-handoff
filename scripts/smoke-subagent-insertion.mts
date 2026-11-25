/**
 * @file 验证桌面本机信任会话的子代理插话。
 * @implementation 用隔离 Electron、真实 Claude SDK 和回环模型核对两种入口及子代理结果。
 * @updated 2026-11-25T23:56:00+08:00
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { subagentInsertionFixture } from '../tests/fixtures/subagent-insertion.js';

const installed = process.argv[2];

for (const language of ['zh', 'en'] as const) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-desktop-subagent-insertion-'));
  const project = join(directory, 'project');
  const fixture = subagentInsertionFixture(project);
  const { gateway } = fixture;
  let app: ElectronApplication | undefined;
  try {
    await mkdir(project);
    await writeFile(join(project, fixture.sampleName), fixture.sampleText);
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    assert.ok(address && typeof address === 'object');
    app = await electron.launch({
      executablePath: installed
        ? resolve(installed)
        : resolve('node_modules/electron/dist/electron'),
      args: [
        ...(installed ? [] : [resolve('dist/desktop/main.mjs')]),
        '--user-data-dir=' + join(directory, 'profile'),
        '--disable-gpu',
      ],
      env: {
        ...process.env,
        ATELIER_DATA_DIR: join(directory, 'data'),
        ATELIER_GATEWAY: 'http://127.0.0.1:' + address.port,
        ATELIER_GATEWAY_TOKEN: 'desktop-subagent-insertion-fixture',
        ATELIER_MODEL: fixture.model,
        ATELIER_PORT: '0',
        ATELIER_NATIVE_EXECUTION: '1',
        ATELIER_MAGPIE_URL: '',
      },
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(12_000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    const bind = page.getByRole('dialog', { name: '绑定项目目录' });
    await bind.getByLabel('本机目录').fill(project);
    await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
    await bind.waitFor({ state: 'hidden' });
    if (language === 'en') {
      const session = page.url();
      await page.goto(new URL('/#/settings/models', session).href);
      await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
      await page.getByRole('option', { name: 'English', exact: true }).click();
      await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
      await page.goto(session);
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    }
    const input = page.locator('#prompt-input');
    await input.fill(fixture.initial);
    await input.press('Enter');
    const task = (title: string) =>
      page
        .locator('details[data-subagent-id]')
        .filter({ has: page.locator('summary').getByText(title, { exact: true }) })
        .first();
    const running = language === 'zh' ? '运行中' : 'Running';
    for (const child of fixture.children) {
      await task(child.title)
        .locator(':scope > summary')
        .getByText(running, { exact: true })
        .waitFor();
    }

    const inserted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/insert'),
    );
    await input.fill(fixture.steer);
    if (language === 'zh') {
      await input.press('Control+Enter');
    } else {
      await input.press('Enter');
      const action = page.getByRole('button', { name: 'Insert message 1 now', exact: true });
      await action.waitFor();
      assert.ok(fixture.parentInputs.every((text) => !text.includes(fixture.steer)));
      await action.click();
    }
    const response = await inserted;
    assert.ok(
      response.ok(),
      'Insert response ' + response.status() + ': ' + (await response.text()),
    );
    await page.getByText(fixture.acknowledgement, { exact: true }).first().waitFor();
    assert.ok(fixture.parentInputs.some((text) => text.includes(fixture.steer)));
    for (const child of fixture.children) {
      await task(child.title)
        .locator(':scope > summary')
        .getByText(running, { exact: true })
        .waitFor();
    }

    for (const child of fixture.children) child.release();
    await page.getByText(fixture.collected, { exact: true }).first().waitFor();
    const finished = page.getByRole('button', {
      name: language === 'zh' ? /^已完成 · 用时/u : /^Completed ·/u,
    });
    await finished.first().waitFor();
    await finished.first().click();
    for (const child of fixture.children) {
      const item = task(child.title);
      if ((await item.getAttribute('open')) === null)
        await item.locator(':scope > summary').click();
      await item.getByText(new RegExp(child.report, 'u')).first().waitFor();
    }
    assert.deepEqual(fixture.errors, []);
    console.log(
      JSON.stringify({
        result: 'passed',
        language,
        entry: language === 'zh' ? 'Ctrl+Enter' : 'queue action',
        childCount: 2,
        parentRespondedBeforeChildren: true,
        bothReportsVisible: true,
        modelTransport: 'loopback',
        installed: Boolean(installed),
      }),
    );
  } finally {
    for (const child of fixture.children) child.release();
    await app?.close();
    gateway.closeAllConnections();
    await new Promise<void>((done) => gateway.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}
