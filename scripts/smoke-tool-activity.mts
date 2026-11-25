/**
 * @file 从隔离 Electron 窗口验证会话内工具活动和原生 Bash 控制。
 * @implementation 用回环模型与真实窗口核对工具事件、历史和日志，验证中英文命令操作、后台消息投递与同目录会话隔离。
 * @updated 2026-11-25T22:48:09+08:00
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { sendModelReply } from '../tests/fixtures/subagent-gateway.js';

const directory = await mkdtemp(join(tmpdir(), 'atelier-activity-'));
const project = join(directory, 'project');
const model = 'fixture-activity';
const command = `printf 'branch=%s\\n' fixture; while test ! -f receipt.ready; do sleep 0.05; done\n# ${'long argument '.repeat(320)}END_OF_FIXTURE_COMMAND`;
const middle = 'UI_ONLY_FIXTURE_MIDDLE';
// Beyond the SDK's head/tail receipt, while remaining below the saved-log budget.
const longOutput =
  'log-line-fixture\n'.repeat(6400) + middle + '\n' + 'log-tail-fixture\n'.repeat(6400);
assert.ok(Buffer.byteLength(longOutput, 'utf8') > 200 * 1024);
let invocations = 0;
let modelGotSummary = false;
const controlPrompts = ['BASH_CONTROL_FIRST_SESSION', 'BASH_CONTROL_SECOND_SESSION'] as const;
const controlCalls = new Set<string>();
const followup = 'BASH_CONTROL_CHANGE_DIRECTION';
let receivedFollowup = false;
const gateway = createServer(async (req, res) => {
  if (req.method !== 'POST')
    return res.end(JSON.stringify(req.url === '/routes' ? { data: [{ model }] } : {}));
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const wire = Buffer.concat(chunks).toString();
  const controlLane = controlPrompts.findIndex((marker) => wire.includes(marker));
  if (controlLane >= 0) {
    const toolId = 'toolu_bash_control_' + controlLane;
    if (!controlCalls.has(toolId)) {
      controlCalls.add(toolId);
      return sendModelReply(res, model, [
        {
          name: 'Bash',
          id: toolId,
          input: {
            command: `printf 'started-${controlLane}\\n'; while ! test -f release-control-${controlLane}; do sleep 0.05; done; printf 'completed-${controlLane}\\n'`,
            description: 'Run the isolated command control fixture',
            timeout: 120_000,
          },
        },
      ]);
    }
    if (wire.includes(followup)) receivedFollowup = true;
    return sendModelReply(res, model, 'Fixture Bash control reply.');
  }
  if (++invocations === 1)
    return sendModelReply(res, model, [
      {
        name: 'Bash',
        id: 'toolu_activity',
        input: { command, description: 'Check fixture branch and wait for release' },
      },
    ]);
  if (invocations === 2)
    return sendModelReply(res, model, [
      {
        name: 'Bash',
        id: 'toolu_long_ui',
        input: { command: 'cat long-receipt.txt', description: 'Inspect synthetic log' },
      },
    ]);
  modelGotSummary =
    wire.includes('工具输出摘要') && wire.includes('read_tool_output') && !wire.includes(middle);
  sendModelReply(res, model, '检查已完成。');
});
let app: ElectronApplication | undefined;
try {
  await mkdir(project);
  await writeFile(join(project, 'long-receipt.txt'), longOutput);
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  app = await electron.launch({
    executablePath: resolve('node_modules/electron/dist/electron'),
    args: [
      resolve('dist/desktop/main.mjs'),
      `--user-data-dir=${join(directory, 'profile')}`,
      '--disable-gpu',
    ],
    env: {
      ...process.env,
      ATELIER_DATA_DIR: join(directory, 'data'),
      ATELIER_GATEWAY: `http://127.0.0.1:${address.port}`,
      ATELIER_GATEWAY_TOKEN: 'tool-activity-fixture',
      ATELIER_MODEL: model,
      ATELIER_PORT: '0',
      ATELIER_NATIVE_EXECUTION: '1',
      ATELIER_MAGPIE_URL: '',
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  const bind = page.getByRole('dialog', { name: '绑定项目目录' });
  await bind.getByLabel('本机目录').fill(project);
  await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
  await bind.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#resize-inspector').count(), 0);
  const input = page.locator('#prompt-input');
  await input.fill('检查测试分支。');
  await input.press('Enter');
  const row = page.locator('.run-tool-list details[data-tool-id$="toolu_activity"]');
  await row.locator(':scope > summary').waitFor();
  const live = page.locator('.run-progress[data-active="true"]');
  const liveBar = live.locator('.run-live-activity-bar');
  assert.match((await liveBar.getByRole('status').textContent()) ?? '', /正在调用.*Bash/u);
  const toolsToggle = liveBar.getByRole('button', { name: /0 \/ 1 已结束/ });
  assert.equal(await toolsToggle.getAttribute('aria-expanded', { timeout: 3000 }), 'true');
  assert.equal(
    await live.evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgba(0, 0, 0, 0)',
  );
  await toolsToggle.press('Enter');
  assert.equal(await row.count(), 0);
  await toolsToggle.press('Space');
  assert.ok((await row.locator(':scope > summary').innerText()).includes('printf'));
  await row.locator(':scope > summary').click();
  await row.getByText(command, { exact: true }).waitFor();
  await writeFile(join(project, 'receipt.ready'), 'ready');
  await page.getByText('检查已完成。', { exact: true }).first().waitFor();
  await row.getByText('branch=fixture', { exact: true }).waitFor();
  assert.equal(await row.evaluate((el) => el.hasAttribute('open')), true);
  await page.getByRole('tab', { name: /执行轨迹/ }).click();
  const finish = page
    .locator('details[data-event-type="tool.finished"]')
    .filter({ hasText: 'printf' });
  await finish.locator(':scope > summary').click();
  await finish.getByText('branch=fixture', { exact: true }).waitFor();
  const traceHash = new URL(page.url()).hash;
  await page.getByRole('button', { name: '浏览器', exact: true }).click();
  await page.getByRole('region', { name: '浏览器面板' }).waitFor();
  await page.getByRole('button', { name: '关闭浏览器' }).click();
  await page.waitForURL((url) => url.hash === traceHash);
  await page.getByRole('region', { name: '运行执行轨迹' }).waitFor();
  assert.equal(await page.locator('#resize-inspector').count(), 0);
  await page.getByRole('tab', { name: '会话', exact: true }).click();
  await page.getByRole('button', { name: /^已完成 · 用时/ }).click();
  await row.locator(':scope > summary').click();
  await row.getByText(command, { exact: true }).waitFor();
  await row.getByText('branch=fixture', { exact: true }).waitFor();
  if (process.env.ATELIER_ACTIVITY_SCREENSHOT)
    await page.screenshot({ path: process.env.ATELIER_ACTIVITY_SCREENSHOT });
  const longRow = page.locator('.run-tool-list details[data-tool-id$="toolu_long_ui"]');
  await longRow.locator(':scope > summary').click();
  assert.match(await longRow.innerText(), /SDK 回执预览/u);
  assert.equal((await longRow.innerText()).includes(middle), false);
  await longRow.getByRole('button', { name: '查看完整日志', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '完整 Bash 日志' });
  const content = dialog.getByLabel('工具输出内容');
  await content.waitFor();
  assert.equal((await content.innerText()).includes(middle), false);
  let pagesToMiddle = 0;
  while (!(await content.innerText()).includes(middle)) {
    assert.ok(pagesToMiddle < 20, 'middle marker missing from saved-log pages');
    const previous = await content.textContent();
    const next = dialog.getByRole('button', { name: '下一页', exact: true });
    assert.equal(await next.isEnabled(), true);
    await next.click();
    await page.waitForFunction(
      (text) => document.querySelector('pre[aria-label="工具输出内容"]')?.textContent !== text,
      previous,
    );
    await content.waitFor();
    pagesToMiddle++;
  }
  assert.ok(pagesToMiddle > 0);
  // Set the destination in the isolated Electron session before invoking the actual link.
  const downloadPath = join(directory, 'downloaded-bash-log.txt');
  const downloadDone = app.evaluate(
    ({ BrowserWindow }, path) =>
      new Promise<string>((done, reject) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) throw new Error('Missing activity test window');
        const timer = setTimeout(() => reject(new Error('No completed Electron download')), 15000);
        window.webContents.session.once('will-download', (_event, item) => {
          const filename = item.getFilename();
          item.setSavePath(path);
          item.once('done', (_doneEvent, state) => {
            clearTimeout(timer);
            if (state === 'completed') done(filename);
            else reject(new Error(`Electron download ended as ${state}`));
          });
        });
      }),
    downloadPath,
  );
  const [filename] = await Promise.all([
    downloadDone,
    dialog.getByRole('link', { name: '下载完整日志', exact: true }).click(),
  ]);
  assert.equal(filename, 'bash-log.txt');
  const downloaded = await readFile(downloadPath, 'utf8');
  assert.equal(downloaded, longOutput);
  assert.ok(downloaded.includes(middle));
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    await longRow
      .getByRole('button', { name: '查看完整日志', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(invocations, 3);
  assert.equal(modelGotSummary, true);

  await input.fill(controlPrompts[0]);
  await input.press('Enter');
  const firstBash = page.locator('details[data-tool-id$="toolu_bash_control_0"]');
  await firstBash.locator(':scope > summary').click();
  await firstBash.getByRole('button', { name: '转到后台', exact: true }).waitFor();
  await firstBash.getByRole('button', { name: '停止命令', exact: true }).waitFor();
  if (process.env.ATELIER_BASH_CONTROL_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.ATELIER_BASH_CONTROL_SCREENSHOT_DIR, 'control-zh.png'),
    });
  await input.fill(followup);
  await input.press('Control+Enter');
  await firstBash.locator(':scope > summary').getByText('后台运行', { exact: true }).waitFor();
  await page.getByText('Fixture Bash control reply.', { exact: true }).first().waitFor();
  assert.equal(receivedFollowup, true);
  const firstSession = page.url();

  await page.goto(new URL('/#/settings/models', firstSession).href);
  await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.goto(firstSession);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.locator('.sidebar-project-new').click();
  await page.waitForURL((url) => url.href !== firstSession);
  await input.fill(controlPrompts[1]);
  await input.press('Enter');
  const secondBash = page.locator('details[data-tool-id$="toolu_bash_control_1"]');
  await secondBash.locator(':scope > summary').click();
  await secondBash.getByRole('button', { name: 'Move to background', exact: true }).click();
  await secondBash
    .locator(':scope > summary')
    .getByText('Running in background', { exact: true })
    .waitFor();
  if (process.env.ATELIER_BASH_CONTROL_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.ATELIER_BASH_CONTROL_SCREENSHOT_DIR, 'control-en.png'),
    });
  await secondBash.getByRole('button', { name: 'Stop command', exact: true }).click();
  await secondBash.locator(':scope > summary').getByText('Stopped', { exact: true }).waitFor();

  await page.goto(firstSession);
  await firstBash
    .locator(':scope > summary')
    .getByText('Running in background', { exact: true })
    .waitFor();
  await firstBash.locator(':scope > summary').click();
  await writeFile(join(project, 'release-control-0'), 'release');
  await firstBash.getByRole('button', { name: 'View full log', exact: true }).click();
  const fullLog = page.getByRole('dialog', { name: 'Full Bash log' });
  await fullLog
    .getByText(/completed-0/)
    .first()
    .waitFor();
  await page.keyboard.press('Escape');
  await fullLog.waitFor({ state: 'hidden' });
  console.log(
    JSON.stringify({
      result: 'passed',
      modelTransport: 'loopback',
      commandVisibleBeforeCompletion: true,
      fullCommandLength: command.length,
      realOutputVisible: true,
      toolEventCorrelated: true,
      historyExpandable: true,
      nativeBashControlledInChineseAndEnglish: true,
      sameDirectorySessionsIndependent: true,
      newInstructionArrivedBeforeBashExit: true,
      sidebarHiddenByDefault: true,
      savedLogBytes: Buffer.byteLength(longOutput, 'utf8'),
      pagesToMiddle,
      savedLogMiddleVisible: true,
      downloadedSavedLogMatches: true,
      firstLogReceiptOmitsMiddle: modelGotSummary,
      outputFocusRestored: true,
    }),
  );
} finally {
  await app?.close();
  gateway.closeAllConnections();
  await new Promise<void>((done) => gateway.close(() => done()));
  await rm(directory, { recursive: true, force: true });
}
