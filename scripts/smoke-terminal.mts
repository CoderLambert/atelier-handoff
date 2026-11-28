/**
 * @file 从隔离开发态 Electron 验收人工终端。
 * @implementation 使用真实配对窗口、PTY 和本地空模型目录，默认覆盖终端交互与 shell 退出。剪贴板模式验证中英文界面的系统复制粘贴、命令中断与重载恢复。
 * @updated 2026-11-28T15:13:32+08:00
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
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
const clipboardOnly = process.argv.includes('--clipboard');
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

// This smoke uses a disposable display and its system clipboard.
async function checkTerminalClipboard(
  application: ElectronApplication,
  page: Page,
  terminalId: string,
  locale: string,
): Promise<void> {
  const terminal = page.locator(`.terminal-viewport[data-terminal-id="${terminalId}"]`);
  const textarea = terminal.locator('.xterm-helper-textarea');
  await until(
    async () => (await textarea.isEditable()) || undefined,
    10_000,
    'Terminal input ready',
  );
  await textarea.focus();
  const marker = `ATELIER_COPY_${locale}`;
  await page.keyboard.insertText(`printf '\\n%s\\n' '${marker}'`);
  await page.keyboard.press('Enter');
  const row = terminal.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^${marker}$`) });
  await row.waitFor();
  const bounds = await row.boundingBox();
  assert.ok(bounds);
  await page.mouse.dblclick(bounds.x + 16, bounds.y + bounds.height / 2);
  await application.evaluate(({ clipboard }) => clipboard.writeText('clipboard-sentinel'));
  await page.keyboard.press('Control+Shift+C');
  await until(
    async () =>
      (await application.evaluate(({ clipboard }) => clipboard.readText())) === marker
        ? true
        : undefined,
    3000,
    'Ctrl+Shift+C copies the selected terminal output to the system clipboard',
  );

  const pasted = `clipboard-中文-${locale}`;
  const filename = `clipboard-${locale}.txt`;
  const path = join(project, filename);
  const command = `printf '%s' '${pasted}' > '${filename}'`;
  await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), command);
  await textarea.focus();
  await page.keyboard.press('Control+Shift+V');
  await until(
    async () =>
      (await terminal.locator('.xterm-rows').innerText()).includes(pasted) ? true : undefined,
    3000,
    'Ctrl+Shift+V pastes system clipboard text into the shell input',
  );
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
  await page.keyboard.press('Enter');
  await until(
    async () =>
      (await readFile(path, 'utf8').catch(() => undefined)) === pasted ? true : undefined,
    3000,
    'The shell receives the pasted command once with Unicode intact',
  );
}

async function runClipboardSmoke(application: ElectronApplication, page: Page, sessionId: string) {
  await page.goto(new URL(`/#/sessions/${sessionId}/terminal`, page.url()).href);
  const panel = page.getByRole('region', { name: '终端', exact: true });
  await panel.getByRole('button', { name: '新建终端', exact: true }).click();
  const terminal = panel.locator('.terminal-viewport[data-terminal-id]');
  const terminalId = z.uuid().parse(await terminal.getAttribute('data-terminal-id'));
  await checkTerminalClipboard(application, page, terminalId, 'zh');

  await page.keyboard.insertText('printf "\\n%s\\n" ATELIER_FOREGROUND; while :; do :; done');
  await page.keyboard.press('Enter');
  await terminal
    .locator('.xterm-rows > div')
    .filter({ hasText: /^ATELIER_FOREGROUND$/u })
    .waitFor();
  await page.keyboard.press('Control+c');
  await page.keyboard.insertText('printf "\\n%s\\n" ATELIER_INTERRUPT_OK');
  await page.keyboard.press('Enter');
  await terminal
    .locator('.xterm-rows > div')
    .filter({ hasText: /^ATELIER_INTERRUPT_OK$/u })
    .waitFor();
  await page.reload();
  await terminal
    .locator('.xterm-rows > div')
    .filter({ hasText: /^ATELIER_INTERRUPT_OK$/u })
    .waitFor();
  return { shutdownTerminalId: terminalId, ctrlC: true, reloadRetainedTerminal: true };
}

try {
  await Promise.all([
    mkdir(project),
    mkdir(terminalTestHome),
    mkdir(evidence, { recursive: true }),
  ]);
  await writeFile(join(terminalTestHome, '.zshrc'), '');
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
  const result = clipboardOnly
    ? await runClipboardSmoke(application, page, sessionId)
    : await runTerminalSmoke({
        page,
        sessionId,
        initialCwd: project,
        screenshotDirectory: evidence,
        resizeWindow: async (width, height) => {
          await application.evaluate(
            ({ BrowserWindow }, size) => {
              BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
            },
            { width, height },
          );
        },
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
  await page.getByRole('region', { name: 'Terminal', exact: true }).waitFor();
  if (clipboardOnly)
    await checkTerminalClipboard(application, page, result.shutdownTerminalId, 'en');
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
        ...(clipboardOnly ? { systemClipboard: true } : {}),
        appShutdownMs: Date.now() - started,
        ...(!clipboardOnly ? { allObservedShellsExited: true } : {}),
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
