/**
 * @file 在真实 Linux Electron 窗口复验有错误的交付和修正后的原件。
 * @implementation 用隔离项目、真实 SDK 和回环模型提交 HTML，并核对页面回执、实际打印尺寸及第二次失败的终态。
 * @updated 2026-11-28T19:38:00+08:00
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import { z } from 'zod';
import { acceptanceReceipt } from '../shared/run-acceptance.js';
import { sendModelReply } from '../tests/fixtures/subagent-gateway.js';

const scratch = await mkdtemp(join(tmpdir(), 'atelier-delivery-check-'));
const project = join(scratch, 'project');
await mkdir(project);
const model = 'acceptance-loopback-fixture';
let requestCount = 0;
let correctionHeard = false;
const gateway = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
    res.end('{}');
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  ++requestCount;
  if (requestCount === 1 || requestCount === 3) {
    const corrected = requestCount === 3;
    if (corrected) correctionHeard = raw.includes('612 × 792') && raw.includes('A4');
    const html =
      '<!doctype html><style>' +
      (corrected ? '@page { size: A4 }' : '') +
      '</style><h1>Atelier handout</h1><p>Registration at 09:30</p>';
    sendModelReply(res, model, [
      {
        name: 'mcp__atelier__publish_artifact',
        id: 'toolu_html_' + requestCount,
        input: { name: 'handout.html', content: html },
      },
    ]);
  } else {
    sendModelReply(res, model, '已完成。');
  }
});
await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
const address = gateway.address();
assert.ok(address && typeof address !== 'string');
const installed = process.argv[2];
try {
  const app = await _electron.launch({
    chromiumSandbox: true,
    executablePath: installed ? resolve(installed) : resolve('node_modules/electron/dist/electron'),
    args: [
      ...(installed ? [] : [resolve('dist/desktop/main.mjs')]),
      '--user-data-dir=' + join(scratch, 'profile'),
      '--disable-gpu',
      ...(process.env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : []),
    ],
    env: {
      ...process.env,
      ATELIER_PORT: '0',
      ATELIER_DATA_DIR: join(scratch, 'data'),
      ATELIER_GATEWAY: 'http://127.0.0.1:' + address.port,
      ATELIER_GATEWAY_TOKEN: model,
      ATELIER_MODEL: model,
      ATELIER_MAGPIE_URL: '',
    },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(30_000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    const bind = page.getByRole('dialog', { name: '绑定项目目录' });
    await bind.getByLabel('本机目录').fill(project);
    await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
    await bind.waitFor({ state: 'hidden' });
    const input = page.locator('#prompt-input');
    await input.fill('只交付 handout.html。检查 375px、1440px 布局和单页 A4 打印。');
    await input.press('Enter');
    await page.getByText('已核验 6 项交付条件', { exact: true }).waitFor();
    await page.getByText('已核验此版本', { exact: true }).waitFor();
    assert.equal(requestCount, 4);
    assert.ok(correctionHeard);
    const sessionUrl = page.url();
    const sessionId = sessionUrl.split('/').at(-1);
    const snapshot = z
      .object({
        runs: z.array(z.object({ status: z.string() })),
        events: z.array(z.object({ type: z.string(), payload: z.unknown() })),
        artifacts: z.array(z.object({ id: z.string(), fingerprint: z.string() })),
      })
      .parse(
        await page.evaluate(async (id) => (await fetch('/api/sessions/' + id)).json(), sessionId),
      );
    const receipts = snapshot.events
      .filter((e) => e.type === 'run.acceptance_checked')
      .map((e) => acceptanceReceipt.parse(e.payload));
    assert.deepEqual(
      snapshot.runs.map((r) => r.status),
      ['completed'],
    );
    assert.deepEqual(
      receipts.map((r) => r.correctionRequested),
      [true, false],
    );
    assert.equal(snapshot.artifacts.length, 2);
    for (const [index, r] of receipts.entries()) {
      const a4 = r.checks.find((c) => c.criterion === 'html.a4');
      assert.ok(a4 && snapshot.artifacts[index]);
      assert.equal(a4.fingerprint, snapshot.artifacts[index]?.fingerprint);
      assert.equal(a4.artifactId, snapshot.artifacts[index]?.id);
      assert.equal(a4.status, index ? 'passed' : 'failed');
      console.log(r.phase, a4.detail, a4.fingerprint);
    }
    await page.reload();
    await page.getByText('已核验此版本', { exact: true }).waitFor();
    await page.goto(new URL('/#/settings/models', page.url()).href);
    await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
    await page.goto(sessionUrl);
    await page.getByText('Verified delivery conditions (6)', { exact: true }).waitFor();
    await input.fill('Only reply with 22.');
    await input.press('Enter');
    await page.getByText('Delivery checks failed', { exact: true }).waitFor();
    assert.equal(requestCount, 6);
    const section = page.locator('.run-recovery[data-status="failed"]');
    await section.getByRole('button', { name: /trace/i }).click();
    await page
      .getByText('Delivery check failed, correction requested', { exact: true })
      .last()
      .waitFor();
    await page.getByText('Delivery recheck', { exact: true }).last().waitFor();
    console.log(
      'Passed Linux Electron / real SDK / scripted model: Letter → A4, accepted current version after reload, two false replies → failed (no third request); zh-CN and en.',
    );
  } finally {
    await app.close();
  }
} finally {
  gateway.closeAllConnections();
  await new Promise<void>((done) => gateway.close(() => done()));
  await rm(scratch, { recursive: true, force: true });
}
