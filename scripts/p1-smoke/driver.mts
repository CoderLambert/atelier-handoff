/**
 * @file 执行已安装 Linux 应用的验收流程。
 * @implementation 驱动界面与离线夹具，检查功能、进程和资源并记录证据。
 * @updated 2026-11-20T02:00+08:00
 */
// External acceptance controller, compiled from TS into a temporary test resource.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright-core';
import type { Store } from '../../server/store.js';
import type { FileRecords } from '../../server/artifacts.js';
type Chromium = typeof import('playwright-core').chromium;
import {
  array,
  config,
  errorText,
  record,
  redact,
  string,
  until,
  type AcceptanceEvidence,
  type DriverConfig,
  type LaunchEvidence,
  type ProcessSample,
} from './contracts.mjs';
import {
  answer,
  bluePixels,
  fixtures,
  model,
  prompt,
  receipt,
  receiptName,
  samplePdf,
  type Fixtures,
} from './fixtures.mjs';

const root = '/smoke';
const sampleInterval = 150;
const freshStarts = 10;
const evidence: AcceptanceEvidence = {
  schema: 1,
  status: 'failed',
  phase: 'prerequisites',
  checks: {},
  launches: [],
};
const redactLog = (text: string): string => redact(text).replace(/\b[a-f0-9]{64}\b/gi, '<hex-64>');

async function appFetch(page: Page, path: string): Promise<{ status: number; body: string }> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.text() };
  }, path);
}

async function api(page: Page, path: string): Promise<Record<string, unknown>> {
  const response = await appFetch(page, path);
  assert.equal(response.status, 200, `API ${path}`);
  return record(JSON.parse(response.body), path);
}

async function processes(): Promise<ProcessSample[]> {
  const rows: ProcessSample[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const path = `/proc/${entry}`;
      const [stat, status, executable, cmdline] = await Promise.all([
        readFile(path + '/stat', 'utf8'),
        readFile(path + '/status', 'utf8'),
        readlink(path + '/exe'),
        readFile(path + '/cmdline', 'utf8'),
      ]);
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      const state = fields[0],
        parent = Number(fields[1]),
        startTicks = fields[19];
      if (!state || !Number.isSafeInteger(parent) || !startTicks) continue;
      rows.push({
        pid: Number(entry),
        parent,
        state,
        executable,
        args: cmdline.split('\0').filter(Boolean),
        rssKiB: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0),
        startTicks,
      });
    } catch {
      /* Process exited while its snapshot was being read. */
    }
  }
  return rows;
}

function role(row: ProcessSample): string {
  if (
    row.executable ===
      '/opt/atelier/resources/runtime/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude' ||
    row.args.some((arg) => arg.includes('/claude-agent-sdk/cli.js'))
  )
    return 'packaged-sdk-cli';
  if (row.args.some((arg) => arg.endsWith('/server/main.js'))) return 'packaged-sidecar';
  return /(?:^|\s)--type=([a-z-]+)/.exec(row.args.join(' '))?.[1] ?? 'electron-main';
}

interface Launch {
  child: ChildProcess;
  browser: Browser;
  page: Page;
  origin: string;
  directory: string;
  metric: LaunchEvidence;
  seen: Map<number, ProcessSample>;
  sample(): Promise<void>;
  stop(): Promise<void>;
}

async function launch(
  cfg: DriverConfig,
  chromium: Chromium,
  fixture: Fixtures,
  index: number,
  reopen: boolean,
): Promise<Launch> {
  const directory = join(root, `run-${reopen ? 1 : index}`);
  // A previous process's CDP file must never reconnect this launch to an old port.
  await rm(join(directory, 'profile/DevToolsActivePort'), { force: true });
  for (const name of [
    'home',
    'profile',
    'data',
    'project',
    'xdg-config',
    'xdg-data',
    'xdg-cache',
    'xdg-runtime',
  ])
    await mkdir(join(directory, name), { recursive: true, mode: 0o700 });
  const metric: LaunchEvidence = {
    index,
    kind: reopen ? 'offline-reopen' : 'fresh',
    readyMs: null,
    peakRssMiB: 0,
    samples: 0,
    processes: [],
    shutdownMs: null,
    exit: null,
    remaining: [],
    forced: false,
  };
  evidence.launches.push(metric);
  const started = performance.now();
  const child = spawn(
    cfg.launcher ?? cfg.app,
    [
      `--user-data-dir=${join(directory, 'profile')}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
    ],
    {
      cwd: directory,
      env: {
        PATH: '/smoke/empty-path',
        ...(cfg.launcher ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        HOME: join(directory, 'home'),
        XDG_CONFIG_HOME: join(directory, 'xdg-config'),
        XDG_DATA_HOME: join(directory, 'xdg-data'),
        XDG_CACHE_HOME: join(directory, 'xdg-cache'),
        XDG_RUNTIME_DIR: join(directory, 'xdg-runtime'),
        TMPDIR: '/tmp',
        LANG: 'C.UTF-8',
        DISPLAY: ':99',
        ATELIER_DATA_DIR: join(directory, 'data'),
        ATELIER_PORT: '0',
        ATELIER_GATEWAY: fixture.gatewayUrl,
        ATELIER_MODEL: model,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '',
    spawnError: Error | undefined;
  const append = (chunk: Buffer): void => {
    log = (log + chunk.toString()).slice(-256 * 1024);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.once('error', (error) => {
    spawnError = error;
  });
  child.once('exit', (code, signal) => {
    metric.exit = { code, signal };
  });
  const pid = Number(child.pid);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Installed executable failed to spawn');
  const seen = new Map<number, ProcessSample>();
  let sampling: Promise<void> | undefined;
  async function sample(): Promise<void> {
    if (sampling) return sampling;
    sampling = (async () => {
      const all = await processes(),
        owned = new Set<number>([pid]);
      for (const row of all) {
        // Crashpad can reparent before the first sampling tick. This private PID
        // namespace contains only the test controller and this installed app.
        if (row.pid !== process.pid && row.executable.startsWith('/opt/atelier/'))
          owned.add(row.pid);
        if (seen.get(row.pid)?.startTicks === row.startTicks) owned.add(row.pid);
      }
      let previous = -1;
      while (previous !== owned.size) {
        previous = owned.size;
        for (const row of all) if (owned.has(row.parent)) owned.add(row.pid);
      }
      const tree = all.filter((row) => owned.has(row.pid));
      for (const row of tree) seen.set(row.pid, row);
      metric.peakRssMiB = Math.max(
        metric.peakRssMiB,
        Math.round((tree.reduce((sum, row) => sum + row.rssKiB, 0) / 1024) * 10) / 10,
      );
      metric.samples++;
      metric.processes = [...seen.values()].map((row) => ({
        pid: row.pid,
        parent: row.parent,
        executable: row.executable,
        role: role(row),
      }));
    })().finally(() => {
      sampling = undefined;
    });
    return sampling;
  }
  const timer = setInterval(() => {
    void sample().catch((error) => {
      spawnError = error instanceof Error ? error : new Error(String(error));
    });
  }, sampleInterval);
  timer.unref();
  let browser: Browser | undefined, page: Page | undefined;
  let stopped = false;
  async function remaining(): Promise<ProcessSample[]> {
    await sample();
    return (await processes()).filter((row) => seen.get(row.pid)?.startTicks === row.startTicks);
  }
  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    const shutdown = performance.now();
    try {
      if (page && !page.isClosed()) {
        let closeTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            page.close(),
            new Promise<void>((_, reject) => {
              closeTimer = setTimeout(
                () => reject(new Error('Window close timed out')),
                Math.min(3000, cfg.shutdownMs),
              );
            }),
          ]);
        } catch {
          child.kill('SIGTERM');
        } finally {
          clearTimeout(closeTimer);
        }
      } else if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await until(
        async () => ((await remaining()).length === 0 && metric.exit ? true : undefined),
        Math.max(1, cfg.shutdownMs - (performance.now() - shutdown)),
        'graceful application tree exit',
      );
    } catch (error) {
      metric.forced = true;
      const live = await remaining();
      metric.remaining = live.map((row) => row.pid);
      for (const row of live) {
        try {
          process.kill(row.pid, 'SIGKILL');
        } catch {}
      }
      throw error;
    } finally {
      metric.shutdownMs = Math.round(performance.now() - shutdown);
      clearInterval(timer);
      if (sampling) await sampling;
      if (browser) await browser.close().catch(() => {});
      await writeFile(join(root, `launch-${index}.log`), redactLog(log), { mode: 0o600 });
      await save();
    }
    assert.equal(metric.exit?.code, 0, `Application launch ${index} must exit cleanly`);
    assert.equal(
      metric.exit?.signal,
      null,
      `Application launch ${index} must exit without a signal`,
    );
    await access(join(directory, 'profile/Local State'), constants.R_OK);
    assert.ok(metric.shutdownMs <= cfg.shutdownMs, 'Shutdown exceeds budget');
    assert.equal(metric.remaining.length, 0);
  }
  try {
    const endpoint = await until(
      async () => {
        if (spawnError) throw spawnError;
        assert.equal(metric.exit, null, 'Installed application exited before ready');
        const advertised =
          /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+)/.exec(
            log,
          )?.[1];
        if (advertised) return advertised;
        const portFile = await readFile(
          join(directory, 'profile/DevToolsActivePort'),
          'utf8',
        ).catch(() => undefined);
        if (portFile === undefined) return undefined;
        const [portText] = portFile.split('\n');
        const port = Number(portText);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
        return `http://127.0.0.1:${port}`;
      },
      cfg.startupMs,
      'installed Chromium CDP endpoint',
    );
    browser = await chromium.connectOverCDP(endpoint, {
      timeout: Math.max(1, cfg.startupMs - (performance.now() - started)),
    });
    page = await until(
      async () => {
        const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [];
        return pages.find((candidate) => /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(candidate.url()));
      },
      Math.max(1, cfg.startupMs - (performance.now() - started)),
      'installed app page',
    );
    page.setDefaultTimeout(10_000);
    page.on('pageerror', (error) => append(Buffer.from(`\nRenderer error: ${error.message}\n`)));
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type()))
        append(Buffer.from(`\nRenderer ${message.type()}: ${message.text()}\n`));
    });
    const initialProjectDialog = page.getByRole('dialog', { name: '绑定项目目录', exact: true });
    await page
      .getByRole('button', { name: '新建会话', exact: true })
      .or(initialProjectDialog)
      .first()
      .waitFor({
        state: 'visible',
        timeout: Math.max(1, cfg.startupMs - (performance.now() - started)),
      });
    if (await initialProjectDialog.isVisible()) await page.keyboard.press('Escape');
    await page
      .getByRole('button', { name: '模型与网关设置', exact: true })
      .waitFor({ state: 'visible' });
    const origin = new URL(page.url()).origin;
    const bootstrap = await api(page, '/api/bootstrap');
    await access(join(directory, 'data/atelier.sqlite'), constants.R_OK);
    assert.equal(
      record(bootstrap.capabilities).commands,
      false,
      'Missing bwrap must disable commands',
    );
    assert.equal(
      record(bootstrap.connection).available,
      false,
      'Fresh/offline gateway status must be visible',
    );
    if (!reopen) {
      assert.equal(array(bootstrap.projects).length, 0, 'Fresh start must have no project');
      assert.equal(array(bootstrap.sessions).length, 0, 'Fresh start must have no session');
    }
    if (cfg.launcher)
      evidence.checks.packageLauncher = {
        executed: true,
        argumentsForwarded: true,
        startedWithInheritedElectronRunAsNode: true,
        electronModeRestored: true,
      };
    metric.readyMs = Math.round(performance.now() - started);
    assert.ok(metric.readyMs <= cfg.startupMs, 'Startup exceeds budget');
    await sample();
    assert.ok(
      [...seen.values()].some(
        (row) =>
          role(row) === 'packaged-sidecar' &&
          row.executable === '/opt/atelier/resources/runtime/bin/node',
      ),
      'Sidecar must use packaged Node',
    );
    return { child, browser, page, origin, directory, metric, seen, sample, stop };
  } catch (error) {
    if (page && !page.isClosed()) {
      await page
        .screenshot({ path: join(root, `startup-failure-${index}.png`), timeout: 2000 })
        .catch(() => {});
      const text = await page
        .locator('body')
        .innerText({ timeout: 1000 })
        .catch(() => 'Body unavailable');
      append(Buffer.from(`\nStartup page text: ${text}\n`));
    }
    await stop().catch(() => {});
    throw error;
  }
}

async function save(): Promise<void> {
  await writeFile(join(root, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', {
    mode: 0o600,
  });
}

async function settings(page: Page, offline: boolean): Promise<void> {
  await page.getByRole('button', { name: '模型与网关设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByText(offline ? '本机网关未连接' : '本机网关可访问', { exact: true })
    .waitFor({ state: 'visible' });
  await dialog.getByText('命令执行：当前环境不可用', { exact: true }).waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
}

async function functional(
  run: Launch,
  fixture: Fixtures,
): Promise<{ projectId: string; sessionId: string; runId: string; artifactId: string }> {
  const { page, directory } = run;
  await settings(page, true);
  await page.getByRole('button', { name: '打开工作空间设置', exact: true }).click();
  await page.getByLabel('本机目录', { exact: true }).fill(join(directory, 'project'));
  await page.getByRole('button', { name: '绑定项目', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  let bootstrap = await api(page, '/api/bootstrap');
  const project = record(array(bootstrap.projects)[0], 'created project');
  const projectId = string(project.id);
  assert.equal(project.path, join(directory, 'project'));
  await until(
    async () => {
      bootstrap = await api(page, '/api/bootstrap');
      return array(bootstrap.sessions).length ? true : undefined;
    },
    5000,
    'project session creation',
  );
  const session = record(array(bootstrap.sessions)[0], 'created session');
  const sessionId = string(session.id);
  assert.equal(session.projectId, projectId);
  evidence.checks.projectCreatedThroughUi = true;
  async function nativeBrowser(): Promise<void> {
    evidence.phase = 'native-html';
    await save();
    await page.getByRole('button', { name: '浏览器', exact: true }).click();
    await page.getByRole('textbox', { name: '网页地址', exact: true }).fill(fixture.siteUrl);
    await page.getByRole('textbox', { name: '网页地址', exact: true }).press('Enter');
    const native = await until(
      async () =>
        run.browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((candidate) => candidate.url().startsWith(fixture.siteUrl)),
      10_000,
      'native WebContentsView HTML target',
    );
    assert.notEqual(native, page, 'Native web view must be a distinct Chromium target');
    await native
      .getByRole('heading', { name: 'Installed native fixture', exact: true })
      .waitFor({ state: 'visible' });
    await native.getByLabel('Fixture input', { exact: true }).fill('installed-native-input');
    assert.equal(
      await native.getByLabel('Fixture input', { exact: true }).inputValue(),
      'installed-native-input',
    );
    await native.screenshot({ path: join(root, 'native-html.png') });
    evidence.checks.nativeHtml = { separateTarget: true, inputVerified: true };
    await page.getByRole('button', { name: '任务详情', exact: true }).first().click();
  }
  evidence.phase = 'packaged-sdk';
  await save();
  fixture.evidence.healthMode = 'online';
  // The ordinary renderer bootstraps gateway status when opening settings.
  await settings(page, false);
  // Edit mode ensures command absence is actually caused by missing bwrap.
  await page.getByRole('button', { name: '模式：只读', exact: true }).click();
  await page.getByRole('textbox', { name: '继续对话', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const snapshot = await until(
    async () => {
      const state = await api(page, `/api/sessions/${sessionId}`);
      const runs = array(state.runs).map((value) => record(value, 'run'));
      const latest = runs.at(-1);
      if (latest && ['failed', 'stopped', 'interrupted'].includes(string(latest.status)))
        throw new Error(
          `Packaged SDK run ${string(latest.status)}: ${JSON.stringify(latest.error)}`,
        );
      return latest?.status === 'completed' ? state : undefined;
    },
    60_000,
    'packaged SDK tool round trip',
  );
  const completedRun = record(array(snapshot.runs).at(-1), 'completed run');
  const artifact = record(array(snapshot.artifacts)[0], 'saved artifact');
  assert.equal(artifact.name, receiptName);
  const artifactId = string(artifact.id),
    runId = string(completedRun.id);
  const messages = array(snapshot.messages).map((value) => record(value, 'message'));
  assert.ok(
    messages.some(
      (message) => message.role === 'assistant' && JSON.stringify(message).includes(answer),
    ),
    'Final reply must be persisted',
  );
  assert.ok(
    string(record(snapshot.session).sdkSessionId),
    'Real SDK session handshake must be persisted',
  );
  assert.equal(fixture.evidence.requests, 2);
  assert.equal(fixture.evidence.toolResultReturned, true);
  assert.deepEqual(fixture.evidence.errors, []);
  await run.sample();
  assert.ok(
    [...run.seen.values()].some(
      (row) =>
        role(row) === 'packaged-sdk-cli' &&
        (row.executable === '/opt/atelier/resources/runtime/bin/node' ||
          row.executable ===
            '/opt/atelier/resources/runtime/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'),
    ),
    'Observed SDK CLI must use the packaged native binary or packaged Node',
  );
  const response = await appFetch(page, `/api/artifacts/${artifactId}/download`);
  assert.equal(response.status, 200, 'Saved artifact content endpoint must work');
  assert.equal(response.body, receipt);
  await page.getByText(answer, { exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({
    path: join(root, 'sdk-completed.png'),
    mask: [page.locator('.history-meta')],
  });
  evidence.checks.packagedSdk = {
    realSdk: true,
    transport: 'loopback SSE replacement',
    paidModelCalls: 0,
    requests: fixture.evidence.requests,
    toolResultReturned: true,
    receiptPersisted: true,
    sdkCliObserved: true,
  };
  await nativeBrowser();
  return { projectId, sessionId, runId, artifactId };
}

async function seedPdf(directory: string, runId: string): Promise<string> {
  const live = (await processes()).filter(
    (row) => row.pid !== process.pid && row.executable.startsWith('/opt/atelier/'),
  );
  assert.equal(
    live.length,
    0,
    'PDF fixture seeding requires the entire application tree to be stopped',
  );
  const storeModule = record(
    (await import(pathToFileURL('/opt/atelier/resources/runtime/server/store.js').href)) as unknown,
  );
  const filesModule = record(
    (await import(
      pathToFileURL('/opt/atelier/resources/runtime/server/artifacts.js').href
    )) as unknown,
  );
  assert.equal(typeof storeModule.Store, 'function');
  assert.equal(typeof filesModule.FileRecords, 'function');
  // Only declarations come from development source. Both executed implementations
  // are imported from the read-only installed artifact after its writer exits.
  const StoreConstructor = storeModule.Store as typeof Store;
  const FileRecordsConstructor = filesModule.FileRecords as typeof FileRecords;
  const output = join(directory, 'fixture-output');
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, 'installed-sample.pdf'), samplePdf(), { mode: 0o600 });
  const store = new StoreConstructor(join(directory, 'data'));
  try {
    const run = store.get('runs', runId);
    assert.equal(run.status, 'completed');
    const artifact = await new FileRecordsConstructor(store).publishFile(
      run,
      output,
      'installed-sample.pdf',
    );
    assert.equal(artifact.mime, 'application/pdf');
    evidence.checks.pdfFixture = {
      seededBy: 'installed FileRecords.publishFile',
      applicationStopped: true,
      singleWriter: true,
      bytes: artifact.size,
    };
    return artifact.id;
  } finally {
    store.close();
  }
}

async function previewPdf(run: Launch, artifactId: string): Promise<void> {
  evidence.phase = 'installed-pdf-preview';
  await save();
  const workers: { url: string; status: number }[] = [];
  const capture = (response: import('playwright-core').Response): void => {
    if (new URL(response.url()).pathname.endsWith('/pdf.worker.min.mjs'))
      workers.push({ url: response.url(), status: response.status() });
  };
  run.page.on('response', capture);
  try {
    const content = await api(run.page, `/api/artifacts/${artifactId}/content`);
    assert.equal(record(content.artifact).mime, 'application/pdf');
    await run.page
      .getByRole('button', { name: /^交付物/ })
      .first()
      .click();
    await run.page.getByRole('button', { name: '预览：installed-sample.pdf', exact: true }).click();
    const dialog = run.page.getByRole('dialog');
    const canvas = dialog.locator('canvas').first();
    await canvas.waitFor({ state: 'visible' });
    const pixels = await until(
      async () => {
        const image = await canvas.screenshot({ timeout: 2000 });
        const painted = bluePixels(image);
        if (painted.blue <= 1000) return undefined;
        await writeFile(join(root, 'installed-pdf-canvas.png'), image, { mode: 0o600 });
        return painted;
      },
      20_000,
      'FileVista PDF.js canvas paints sample PDF',
    );
    await until(
      async () =>
        workers.some((worker) => worker.status === 200 && new URL(worker.url).origin === run.origin)
          ? true
          : undefined,
      5000,
      'packaged local PDF worker fetched',
    );
    assert.ok(
      run.page.workers().some((worker) => new URL(worker.url()).origin === run.origin),
      'Real local PDF worker must be running',
    );
    await run.page.screenshot({ path: join(root, 'installed-pdf-preview.png') });
    evidence.checks.pdfPreview = {
      ...pixels,
      renderer: 'installed FileVista PDF.js canvas',
      workerFetched: true,
      realLocalWorker: true,
      workers: workers.map((worker) => ({
        path: new URL(worker.url).pathname,
        status: worker.status,
      })),
      offline: true,
    };
    await dialog.getByRole('button', { name: '关闭预览', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  } finally {
    run.page.removeListener('response', capture);
  }
}

async function reopen(
  run: Launch,
  fixture: Fixtures,
  ids: { projectId: string; sessionId: string; runId: string; artifactId: string },
): Promise<void> {
  const bootstrap = await api(run.page, '/api/bootstrap');
  assert.equal(record(bootstrap.connection).available, false);
  const project = array(bootstrap.projects)
    .map((value) => record(value))
    .find((item) => item.id === ids.projectId);
  assert.ok(
    project && project.available === true && project.path === join(run.directory, 'project'),
    'Bound project must reopen offline',
  );
  const state = await api(run.page, `/api/sessions/${ids.sessionId}`);
  assert.equal(record(state.session).id, ids.sessionId);
  assert.ok(
    array(state.runs).some((value) => {
      const row = record(value);
      return row.id === ids.runId && row.status === 'completed';
    }),
  );
  assert.ok(
    array(state.messages).some((value) => {
      const row = record(value);
      return row.role === 'assistant' && JSON.stringify(row).includes(answer);
    }),
  );
  assert.ok(array(state.artifacts).some((value) => record(value).id === ids.artifactId));
  const response = await appFetch(run.page, `/api/artifacts/${ids.artifactId}/download`);
  assert.equal(response.status, 200);
  assert.equal(response.body, receipt);
  const session = record(state.session);
  await run.page
    .getByRole('button')
    .filter({ has: run.page.locator('.history-title', { hasText: string(session.title) }) })
    .click();
  await run.page.getByText(answer, { exact: true }).waitFor({ state: 'visible' });
  await settings(run.page, true);
  assert.equal(fixture.evidence.requests, 2, 'Offline reopen must make no model request');
  await run.page.screenshot({
    path: join(root, 'offline-reopened.png'),
    mask: [run.page.locator('.history-meta')],
  });
  evidence.checks.offlineReopen = {
    project: true,
    session: true,
    messages: true,
    completedRun: true,
    artifactContent: true,
    uiHistory: true,
    connectionUnavailable: true,
    additionalModelRequests: 0,
  };
}

async function main(): Promise<void> {
  let xvfb: ChildProcess | undefined, fixture: Fixtures | undefined, active: Launch | undefined;
  let xvfbLog = '';
  try {
    const path = process.argv[2];
    assert.ok(path, 'Driver config path is required');
    const cfg = config(JSON.parse(await readFile(path, 'utf8')) as unknown);
    assert.equal(
      process.execPath,
      '/opt/atelier/resources/runtime/bin/node',
      'Driver itself must use packaged Node in the isolated environment',
    );
    assert.equal(process.env.PATH, '/smoke/empty-path');
    for (const path of [cfg.sourceProbe, '/usr/lib/node_modules/npm', '/usr/share/nodejs/npm'])
      await assert.rejects(access(path, constants.R_OK), `${path} must be unavailable`);
    for (const path of [
      '/usr/bin/node',
      '/usr/bin/nodejs',
      '/usr/bin/npm',
      '/usr/bin/npx',
      '/usr/bin/tsx',
      '/usr/bin/bwrap',
    ]) {
      const stat = await lstat(path).catch(() => null);
      if (stat) assert.ok(!stat.isFile(), `${path} must not be an executable file`);
    }
    evidence.checks.environment = {
      sourceUnavailable: true,
      developmentNodeUnavailable: true,
      npmUnavailable: true,
      bwrapUnavailable: true,
      packagedNode: process.version,
      externalNetwork: 'unshared namespace: loopback only',
      chromiumSandbox: 'enabled; no --no-sandbox argument',
    };
    const loaded = record((await import(pathToFileURL(cfg.playwright).href)) as unknown);
    assert.equal(typeof record(loaded.chromium).connectOverCDP, 'function');
    // Module checked at runtime; the matching real playwright-core declarations
    // define this sole external-controller boundary and all browser calls below.
    const chromium = loaded.chromium as Chromium;
    await mkdir('/tmp/.X11-unix', { mode: 0o1777, recursive: true });
    xvfb = spawn(
      cfg.xvfb,
      [':99', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp', '-ac', '-extension', 'GLX'],
      {
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let xvfbError: Error | undefined;
    xvfb.once('error', (error) => {
      xvfbError = error;
    });
    const appendXvfb = (chunk: Buffer): void => {
      xvfbLog = (xvfbLog + chunk.toString()).slice(-32768);
    };
    xvfb.stdout?.on('data', appendXvfb);
    xvfb.stderr?.on('data', appendXvfb);
    await until(
      async () => {
        if (xvfbError) throw xvfbError;
        assert.equal(xvfb?.exitCode, null, 'Xvfb exited');
        assert.equal(xvfb?.signalCode, null, 'Xvfb was terminated');
        return await access('/tmp/.X11-unix/X99').then(
          () => true,
          () => undefined,
        );
      },
      5000,
      'dedicated Xvfb display',
    );
    fixture = await fixtures();
    let ids: Awaited<ReturnType<typeof functional>> | undefined;
    let pdfArtifactId: string | undefined;
    for (let index = 1; index <= freshStarts; index++) {
      evidence.phase = `fresh-start-${index}`;
      await save();
      active = await launch(cfg, chromium, fixture, index, false);
      try {
        if (index === 1) ids = await functional(active, fixture);
      } catch (error) {
        await active.page
          .screenshot({ path: join(root, 'failure.png'), timeout: 2000 })
          .catch(() => {});
        throw error;
      } finally {
        await active.stop();
        active = undefined;
      }
      if (index === 1 && ids) pdfArtifactId = await seedPdf(join(root, 'run-1'), ids.runId);
      fixture.evidence.healthMode = 'offline';
    }
    assert.ok(ids);
    assert.ok(pdfArtifactId);
    await fixture.disconnectGateway();
    evidence.phase = 'offline-reopen';
    await save();
    active = await launch(cfg, chromium, fixture, freshStarts + 1, true);
    try {
      await reopen(active, fixture, ids);
      await previewPdf(active, pdfArtifactId);
    } catch (error) {
      await active.page
        .screenshot({ path: join(root, 'failure.png'), timeout: 2000 })
        .catch(() => {});
      throw error;
    } finally {
      await active.stop();
      active = undefined;
    }
    assert.equal(evidence.launches.filter((item) => item.kind === 'fresh').length, freshStarts);
    assert.ok(
      evidence.launches.every(
        (item) =>
          item.readyMs !== null &&
          item.shutdownMs !== null &&
          !item.forced &&
          !item.remaining.length,
      ),
    );
    assert.deepEqual(fixture.evidence.errors, []);
    const allProcesses = evidence.launches.flatMap((item) => item.processes);
    assert.ok(
      allProcesses.every((item) => item.executable.startsWith('/opt/atelier/')),
      'Every app process must execute an installed binary',
    );
    evidence.checks.processOwnership = {
      installedExecutablesOnly: true,
      cleanExitCount: evidence.launches.length,
      remainingProcesses: 0,
    };
    evidence.metrics = {
      freshStarts,
      slowestReadyMs: Math.max(
        ...evidence.launches
          .filter((item) => item.kind === 'fresh')
          .map((item) => item.readyMs ?? 0),
      ),
      peakTreeRssMiB: Math.max(...evidence.launches.map((item) => item.peakRssMiB)),
      slowestShutdownMs: Math.max(...evidence.launches.map((item) => item.shutdownMs ?? 0)),
      rssSamplingIntervalMs: sampleInterval,
      budgets: { startupMs: cfg.startupMs, shutdownMs: cfg.shutdownMs, rssMiB: cfg.rssMiB },
    };
    if (cfg.rssMiB !== null)
      assert.ok(
        evidence.metrics.peakTreeRssMiB <= cfg.rssMiB,
        'Sampled process-tree RSS exceeds budget',
      );
    evidence.phase = 'complete';
    evidence.status = 'passed';
  } catch (error) {
    evidence.error = redactLog(errorText(error));
    process.exitCode = 1;
  } finally {
    if (active)
      await active.stop().catch((error) => {
        evidence.checks.cleanupError = redactLog(errorText(error));
      });
    if (fixture) {
      evidence.checks.fixture = fixture.evidence;
      await fixture.close().catch((error) => {
        evidence.checks.fixtureCleanupError = errorText(error);
        evidence.status = 'failed';
        process.exitCode = 1;
      });
    }
    if (xvfb) {
      const exited = new Promise<void>((resolve) => {
        if (xvfb?.exitCode !== null || xvfb?.signalCode !== null) resolve();
        else xvfb?.once('exit', () => resolve());
      });
      xvfb.kill('SIGTERM');
      const timer = setTimeout(() => {
        xvfb?.kill('SIGKILL');
      }, 3000);
      await exited;
      clearTimeout(timer);
      evidence.checks.xvfbStopped = true;
    }
    await writeFile(join(root, 'xvfb.log'), redactLog(xvfbLog), { mode: 0o600 });
    await save();
    process.stdout.write(
      JSON.stringify({
        status: evidence.status,
        phase: evidence.phase,
        error: evidence.error,
        metrics: evidence.metrics,
      }) + '\n',
    );
  }
}

await main();
