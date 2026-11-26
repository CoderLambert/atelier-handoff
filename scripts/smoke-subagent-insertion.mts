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
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { subagentInsertionFixture } from '../tests/fixtures/subagent-insertion.js';

const installed = process.argv[2];
const evidence = process.env.ATELIER_SUBAGENT_SCREENSHOTS;
if (evidence) await mkdir(evidence, { recursive: true });

for (const language of ['zh', 'en'] as const) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-desktop-subagent-insertion-'));
  const project = join(directory, 'project');
  const fixture = subagentInsertionFixture(project, 'steered');
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
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(width, height),
      language === 'zh' ? { width: 1440, height: 900 } : { width: 1280, height: 800 },
    );
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
    await Promise.race([
      fixture.parentStarted,
      delay(12_000, undefined, { ref: false }).then(() => {
        throw new Error('The initial model request did not start.');
      }),
    ]);
    const task = (title: string) =>
      page
        .locator('details[data-subagent-id]')
        .filter({ has: page.locator('summary').getByText(title, { exact: true }) })
        .first();
    const running = language === 'zh' ? '运行中' : 'Running';
    async function insert(text: string, shortcut = language === 'zh') {
      const [response] = await Promise.all([
        page.waitForResponse(
          (reply) =>
            reply.request().method() === 'POST' &&
            new URL(reply.url()).pathname.endsWith('/insert'),
        ),
        (async () => {
          await input.fill(text);
          if (shortcut) {
            await input.press('Control+Enter');
          } else {
            await input.press('Enter');
            const action = page.getByRole('button', { name: 'Insert message 1 now', exact: true });
            await action.waitFor();
            assert.ok(fixture.parentInputs.every((message) => !message.includes(text)));
            await action.click();
          }
        })(),
      ]);
      assert.ok(
        response.ok(),
        'Insert response ' + response.status() + ': ' + (await response.text()),
      );
    }
    await insert(fixture.steer);
    fixture.releaseInitial();
    await page.getByText(fixture.acknowledgement, { exact: true }).first().waitFor();
    assert.ok(fixture.parentInputs.some((text) => text.includes(fixture.steer)));
    const queue = page.locator('.chat-message-queue');
    await queue.waitFor({ state: 'hidden' });
    for (const child of fixture.children) {
      const summary = task(child.title).locator(':scope > summary');
      await summary.getByText(running, { exact: true }).waitFor();
      const activity = summary.locator('[data-subagent-last-tool]');
      await activity
        .filter({
          hasText: language === 'zh' ? /最近工具活动.*Read/u : /Last tool activity.*Read/u,
        })
        .waitFor();
    }
    const live = page.locator('[data-run-live-status]');
    await live
      .getByRole('status')
      .filter({
        hasText: language === 'zh' ? /子任务.*2.*进行中/u : /Running subtasks.*2 in progress/u,
      })
      .waitFor();
    assert.match(
      (await live.locator('[data-run-elapsed]').textContent()) ?? '',
      language === 'zh' ? /本轮用时/u : /Turn elapsed/u,
    );
    if (evidence) await page.screenshot({ path: join(evidence, `subagents-${language}.png`) });
    await insert(fixture.ordinary);
    await page.getByText(fixture.queuedAcknowledgement, { exact: true }).first().waitFor();
    await queue.waitFor({ state: 'hidden' });
    for (const child of fixture.children) child.release();
    await Promise.race([
      fixture.collectionStarted,
      delay(12_000, undefined, { ref: false }).then(() => {
        throw new Error('The parent did not start collecting the reports.');
      }),
    ]);
    await insert(fixture.duringCollection, true);
    fixture.releaseCollection();
    await page.getByText(fixture.collectionAcknowledgement, { exact: true }).first().waitFor();
    await page.getByText(fixture.collected, { exact: true }).first().waitFor();
    await page.locator('.ordered-run .run-summary[data-status="completed"]').first().waitFor();
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
        secondInsertionWhileChildrenRunning: true,
        insertionDuringReportCollection: true,
        queueConfirmedBeforeReports: true,
        branchActivityVisible: true,
        bothReportsVisible: true,
        modelTransport: 'loopback',
        installed: Boolean(installed),
      }),
    );
  } finally {
    fixture.releaseInitial();
    fixture.releaseCollection();
    for (const child of fixture.children) child.release();
    await app?.close();
    gateway.closeAllConnections();
    await new Promise<void>((done) => gateway.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}
