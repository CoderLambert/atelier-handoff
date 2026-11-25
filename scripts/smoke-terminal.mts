/**
 * @file 从隔离开发态 Electron 验收人工终端。
 * @implementation 使用真实配对窗口、PTY 和本地空模型目录，复用终端交互场景并核对所属 shell 的退出身份。
 * @updated 2026-11-26T03:55:00+08:00
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication } from 'playwright-core';
import { z } from 'zod';
import { terminalListResponseSchema } from '../shared/terminal.js';
import {
  allowTerminalShell,
  runTerminalSmoke,
  type TerminalProcessIdentity,
} from './p1-smoke/terminal.mjs';
import { until, type ProcessSample } from './p1-smoke/contracts.mjs';

const directory = await mkdtemp(join(tmpdir(), 'atelier-terminal-desktop-'));
const project = join(directory, 'project');
const terminalTestHome = join(directory, 'home');
const evidence = resolve(
  process.env.ATELIER_TERMINAL_EVIDENCE ?? '.local/terminal-workbench/electron',
);
const model = 'fixture-terminal-no-inference';
let modelRequests = 0;
let app: ElectronApplication | undefined;
let observed: TerminalProcessIdentity[] = [];
let completed = false;
const gateway = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.method !== 'GET') {
    modelRequests++;
    response.writeHead(400).end('{}');
    return;
  }
  response.end(JSON.stringify(request.url === '/routes' ? { data: [{ model }] } : {}));
});

async function processSample(pid: number): Promise<ProcessSample | undefined> {
  try {
    const [stat, executable, command] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readlink(`/proc/${pid}/exe`),
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
    ]);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const state = z
      .string()
      .regex(/^[A-Z]$/u)
      .parse(fields[0]);
    const parent = z.coerce.number().int().min(0).parse(fields[1]);
    const startTicks = z.string().regex(/^\d+$/u).parse(fields[19]);
    return {
      pid,
      parent,
      state,
      executable,
      args: command.split('\0').filter(Boolean),
      rssKiB: 0,
      startTicks,
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
async function shellExited(identity: TerminalProcessIdentity): Promise<boolean> {
  const sample = await processSample(identity.pid);
  return (
    !sample ||
    sample.state === 'Z' ||
    sample.startTicks !== identity.startTicks ||
    sample.executable !== identity.executable
  );
}

try {
  await Promise.all([
    mkdir(project),
    mkdir(terminalTestHome),
    mkdir(evidence, { recursive: true }),
  ]);
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  app = await _electron.launch({
    executablePath: resolve('node_modules/electron/dist/electron'),
    args: [
      resolve('dist/desktop/main.mjs'),
      `--user-data-dir=${join(directory, 'profile')}`,
      '--disable-gpu',
    ],
    env: {
      ...process.env,
      HOME: terminalTestHome,
      XDG_CONFIG_HOME: join(terminalTestHome, 'config'),
      XDG_CACHE_HOME: join(terminalTestHome, 'cache'),
      XDG_DATA_HOME: join(terminalTestHome, 'data'),
      ATELIER_DATA_DIR: join(directory, 'data'),
      ATELIER_PORT: '0',
      ATELIER_GATEWAY: `http://127.0.0.1:${address.port}`,
      ATELIER_MODEL: model,
      ATELIER_NATIVE_EXECUTION: '1',
      ATELIER_MAGPIE_URL: '',
    },
    timeout: 25_000,
  });
  const application = app;
  const mainPid = application.process().pid;
  assert.ok(mainPid);
  const page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  const bind = page.getByRole('dialog', { name: '绑定项目目录' });
  await bind.getByLabel('本机目录').fill(project);
  await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
  await bind.waitFor({ state: 'hidden' });
  await page.waitForURL((url) => /^#\/sessions\/[a-f0-9-]+$/u.test(url.hash));
  const sessionId = z.uuid().parse(new URL(page.url()).hash.split('/')[2]);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800),
  );
  const result = await runTerminalSmoke({
    page,
    sessionId,
    initialCwd: project,
    screenshotDirectory: evidence,
    observeShell: async (pid) => {
      const sample = await processSample(pid);
      assert.ok(sample);
      const sidecar = await processSample(sample.parent);
      assert.ok(sidecar);
      assert.equal(sidecar.parent, mainPid, 'Terminal belongs to this Electron runtime');
      assert.ok(
        sidecar.args.includes(resolve('server/main.ts')),
        'Terminal parent is the actual development sidecar',
      );
      const identity = allowTerminalShell(pid, sidecar.pid, [sample, sidecar]);
      observed.push(identity);
      return identity;
    },
    shellExited,
  });
  // Changing language and returning to the saved route must retain this same terminal.
  const terminalRoute = page.url();
  await page.goto(`${new URL(page.url()).origin}/#/settings/models`);
  await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900),
  );
  await page.goto(terminalRoute);
  await page
    .locator('.terminal-panel')
    .getByRole('heading', { name: 'Terminal', exact: true })
    .waitFor();
  const listed: unknown = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${id}/terminals`);
    return response.json();
  }, sessionId);
  assert.ok(
    terminalListResponseSchema
      .parse(listed)
      .terminals.some((item) => item.terminalId === result.shutdownTerminalId),
  );
  await page.screenshot({ path: join(evidence, 'terminal-en-1440.png') });
  const started = Date.now();
  await application.close();
  app = undefined;
  for (const identity of observed)
    await until(
      async () => ((await shellExited(identity)) ? true : undefined),
      10_000,
      'Application shutdown reaps its Terminal shell',
    );
  assert.equal(modelRequests, 0, 'Manual terminal never invokes the Agent/model API');
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        ...result,
        platform: process.platform,
        node: process.version,
        electron: '45.4.1',
        languages: ['zh-CN', 'en'],
        appShutdownMs: Date.now() - started,
        allObservedShellsExited: true,
        modelRequests,
      },
      null,
      2,
    ),
  );
  completed = true;
  console.log(
    JSON.stringify({ terminalDesktop: 'passed', evidence, modelRequests, shells: observed.length }),
  );
} finally {
  if (app) await app.close().catch(() => {});
  await new Promise<void>((done) => gateway.close(() => done()));
  if (completed) await rm(directory, { recursive: true, force: true });
  else console.error(`Terminal smoke failed; isolated evidence retained at ${directory}`);
}
