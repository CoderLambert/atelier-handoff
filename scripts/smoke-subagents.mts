#!/usr/bin/env -S tsx
/**
 * @file 验证 Linux Electron 窗口中的子任务、审批和离线重开。
 * @implementation 用回环模型夹具驱动实际 SDK，在隔离数据与 profile 中点击审批并比对文件与历史。
 * @updated 2026-11-21T12:00:00+00:00
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { sendModelReply } from '../tests/fixtures/subagent-gateway.js';

const model = 'atelier-subagent-desktop-fixture';
const main =
  'Inspect and update the three desktop fixture files independently. DESKTOP_DELEGATION_MAIN';
const names = ['Desktop Alpha', 'Desktop Beta', 'Desktop Gamma'];
const markers = ['DESKTOP_CHILD_ALPHA', 'DESKTOP_CHILD_BETA', 'DESKTOP_CHILD_GAMMA'];
const sites = ['baidu.com', 'toutiao.com'];
const searchMain = 'Search the two sites independently. DESKTOP_SEARCH_MAIN';
const searchOutput = 'DESKTOP_SEARCH_SUMMARY';
const searchedSites: string[] = [];
const output = 'DESKTOP_DELEGATION_SUMMARY';
const directory = await mkdtemp(join(tmpdir(), 'atelier-subagent-desktop-'));
const project = join(directory, 'project');
await mkdir(project);
await Promise.all(names.map((name, i) => writeFile(join(project, `${i}.txt`), `${name}\n`)));
const errors: string[] = [];
let requests = 0;
const gateway = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (pathname !== '/v1/messages') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, model);
    requests++;
    const text = JSON.stringify(body.messages);
    if (body.stream !== true) {
      const hosted = body.tools.find(
        ({ type }: { type: string }) => type === 'web_search_20250305',
      );
      const domain = sites.find((site) => hosted?.allowed_domains?.[0] === site);
      assert.ok(domain);
      searchedSites.push(domain);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          content: [
            { type: 'server_tool_use', name: 'web_search' },
            {
              type: 'text',
              text: 'Fixture search response',
              citations: [{ url: `https://${domain}/fixture`, title: `Fixture ${domain}` }],
            },
          ],
        }),
      );
      return;
    }
    const searchSite = !text.includes(searchMain)
      ? sites.find((site) => text.includes(`DESKTOP_SEARCH_CHILD_${site}`))
      : undefined;
    if (searchSite) {
      const id = `toolu_desktop_search_${sites.indexOf(searchSite)}`;
      if (text.includes(id)) {
        assert.ok(text.includes(`https://${searchSite}/fixture`));
        sendModelReply(res, model, `SEARCH_REPORT_${searchSite}`);
      } else {
        assert.ok(
          body.tools.some(({ name }: { name: string }) => name === 'mcp__atelier__web_search'),
        );
        sendModelReply(res, model, [
          {
            name: 'mcp__atelier__web_search',
            id,
            input: { domain: searchSite, query: 'Fixture news' },
          },
        ]);
      }
      return;
    }
    if (text.includes(searchMain)) {
      if (text.includes('toolu_desktop_site_spawn_')) {
        assert.ok(sites.every((site) => text.includes(`SEARCH_REPORT_${site}`)));
        sendModelReply(res, model, searchOutput);
      } else {
        sendModelReply(
          res,
          model,
          sites.map((site, i) => ({
            name: 'Agent',
            id: `toolu_desktop_site_spawn_${i}`,
            input: {
              description: `Search ${site}`,
              prompt: `DESKTOP_SEARCH_CHILD_${site}`,
              subagent_type: 'atelier-explore',
              run_in_background: false,
            },
          })),
        );
      }
      return;
    }
    const index = text.includes(main) ? -1 : markers.findIndex((marker) => text.includes(marker));
    if (index >= 0) {
      const id = `toolu_desktop_edit_${index}`;
      const report = `REPORT_DESKTOP_${index}`;
      if (text.includes(id)) sendModelReply(res, model, report);
      else
        sendModelReply(res, model, [
          {
            name: 'mcp__atelier__edit_file',
            id,
            input: {
              path: `${index}.txt`,
              oldText: names[index],
              newText: `Updated ${names[index]}`,
              reason: 'Fixture edit',
            },
          },
        ]);
    } else if (text.includes('toolu_desktop_spawn_')) {
      assert.ok(names.every((_, index) => text.includes(`REPORT_DESKTOP_${index}`)));
      sendModelReply(res, model, output);
    } else {
      assert.ok(text.includes(main));
      sendModelReply(
        res,
        model,
        names.map((description, i) => ({
          name: 'Agent',
          id: `toolu_desktop_spawn_${i}`,
          input: {
            description,
            prompt: markers[i],
            subagent_type: 'atelier-worker',
            run_in_background: false,
          },
        })),
      );
    }
  } catch (error) {
    errors.push(String(error));
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: String(error) },
      }),
    );
  }
});
await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
const address = gateway.address();
assert.ok(address && typeof address === 'object');
const gatewayUrl = `http://127.0.0.1:${address.port}`;
let app: ElectronApplication | undefined;
const installed = process.argv[2];
async function launch() {
  return electron.launch({
    executablePath: installed ? resolve(installed) : resolve('node_modules/electron/dist/electron'),
    args: [
      ...(installed ? [] : [resolve('dist/desktop/main.mjs')]),
      `--user-data-dir=${join(directory, 'profile')}`,
      '--disable-gpu',
    ],
    env: {
      ...process.env,
      ATELIER_DATA_DIR: join(directory, 'data'),
      ATELIER_PORT: '0',
      ATELIER_GATEWAY: gatewayUrl,
      ATELIER_MODEL: model,
    },
    timeout: 25_000,
  });
}
try {
  app = await launch();
  let page = await app.firstWindow();
  page.setDefaultTimeout(12_000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
  const projectDialog = page.getByRole('dialog', { name: '绑定项目目录' });
  const opened = await projectDialog.waitFor({ timeout: 3_000 }).then(
    () => true,
    () => false,
  );
  if (!opened) {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '打开工作空间设置', exact: true }).click();
  }
  await projectDialog.getByLabel('本机目录', { exact: true }).fill(project);
  await projectDialog.getByRole('button', { name: '绑定项目', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const mode = page.getByRole('combobox', { name: '运行模式' });
  await mode.click();
  await page.getByRole('option', { name: /受控修改/ }).click();
  const input = page.getByRole('textbox', { name: '继续对话', exact: true });
  await input.fill(main);
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/messages'),
    { timeout: 5_000 },
  );
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const response = await sent;
  assert.ok(response.ok(), `Submit ${response.status()}: ${await response.text()}`);
  const openTask = (title: string) =>
    page
      .locator('details[data-subagent-id]')
      .filter({ has: page.locator('summary').getByText(title, { exact: true }) })
      .first();
  const alpha = openTask('Desktop Alpha');
  const beta = openTask('Desktop Beta');
  await alpha.getByText('待审批 1', { exact: true }).waitFor();
  await beta.getByText('待审批 1', { exact: true }).waitFor();
  const gamma = openTask('Desktop Gamma');
  await gamma.getByText('待审批 1', { exact: true }).waitFor();
  await alpha.locator(':scope > summary').click();
  assert.equal(await beta.getByRole('button', { name: '查看并审批' }).isVisible(), false);
  await alpha.getByRole('button', { name: '查看并审批' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('子代理 · Desktop Alpha', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '允许本次操作' }).click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  await dialog.waitFor({ state: 'hidden' });
  await beta.locator(':scope > summary').click();
  await beta.getByRole('button', { name: '查看并审批' }).click();
  await dialog.getByText('子代理 · Desktop Beta', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '拒绝', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  await gamma.locator(':scope > summary').click();
  await gamma.getByRole('button', { name: '查看并审批' }).click();
  await dialog.getByText('子代理 · Desktop Gamma', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '允许本次操作' }).click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  await page.getByText(output, { exact: true }).waitFor();
  assert.equal(await readFile(join(project, '2.txt'), 'utf8'), 'Updated Desktop Gamma\n');
  assert.equal(await readFile(join(project, '0.txt'), 'utf8'), 'Updated Desktop Alpha\n');
  assert.equal(await readFile(join(project, '1.txt'), 'utf8'), 'Desktop Beta\n');
  await page.screenshot({ path: join(directory, 'completed.png') });
  await input.fill(searchMain);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await page.getByText(searchOutput, { exact: true }).waitFor();
  assert.deepEqual(searchedSites.sort(), sites);
  for (const site of sites) {
    const task = openTask(`Search ${site}`);
    await task.locator(':scope > summary').click();
    await task.getByText(`SEARCH_REPORT_${site}`, { exact: true }).waitFor();
    await task.getByText('web_search', { exact: true }).waitFor();
  }
  await page.screenshot({ path: join(directory, 'site-search.png') });
  await app.close();
  app = undefined;
  const count = requests;
  app = await launch();
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  await page.getByText(output, { exact: true }).waitFor({ timeout: 15_000 });
  const saved = openTask('Desktop Beta');
  await saved.locator(':scope > summary').click();
  await saved.getByText('REPORT_DESKTOP_1', { exact: true }).waitFor();
  assert.equal(requests, count);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(directory, 'reopened.png') });
  console.log(
    JSON.stringify({
      result: 'passed',
      installed: Boolean(installed),
      modelTransport: 'loopback',
      requests,
      evidence: directory,
    }),
  );
} catch (error) {
  const view = app?.windows()[0];
  const text = await view
    ?.locator('body')
    .innerText({ timeout: 1_000 })
    .catch(() => '');
  await view?.screenshot({ path: join(directory, 'failure.png'), timeout: 2_000 }).catch(() => {});
  console.error(
    JSON.stringify({ errors, requests, evidence: directory, view: text?.slice(-1000) }),
  );
  throw error;
} finally {
  await app?.close().catch(() => {});
  gateway.closeAllConnections();
  await new Promise<void>((done) => gateway.close(() => done()));
  await rm(join(directory, 'profile'), { recursive: true, force: true });
}
