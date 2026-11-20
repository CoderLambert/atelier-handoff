/**
 * @file 执行 Linux 安装态验收。
 * @implementation 驱动隔离界面与回环夹具，验证网页、下载、文件预览、系统打开、网关和进程管理等流程，并核对项目边界。
 * @updated 2026-11-20T20:17:41+08:00
 */
// External acceptance controller, compiled from TS into a temporary test resource.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright-core';
import type { DesktopBrowserBridge } from '../../shared/desktop-browser.js';
import type { Store } from '../../server/store.js';
import type { FileRecords } from '../../server/artifacts.js';
type Chromium = typeof import('playwright-core').chromium;
import {
  array,
  browserAccess,
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
  alternateModel,
  answer,
  automaticAnswer,
  automaticFollowupAnswer,
  automaticFollowupPrompt,
  automaticMcpName,
  automaticMcpTool,
  automaticPrompt,
  automaticReceipt,
  automaticReceiptName,
  automaticToolCount,
  bluePixels,
  browserEditAnswer,
  browserEditPrompt,
  browserDownloadBody,
  browserDownloadLabel,
  browserDownloadName,
  browserManualValue,
  browserReadAnswer,
  browserReadPrompt,
  browserTitle,
  chatLinkLabel,
  chatLinkPath,
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

async function appFetch(
  page: Page,
  path: string,
  mutation?: { method: 'POST' | 'PATCH'; body: Record<string, unknown>; token: string },
): Promise<{ status: number; body: string }> {
  return page.evaluate(
    async ({ path, mutation }) => {
      const response = await fetch(path, {
        signal: AbortSignal.timeout(5000),
        ...(mutation
          ? {
              method: mutation.method,
              headers: { 'Content-Type': 'application/json', 'x-atelier-token': mutation.token },
              body: JSON.stringify(mutation.body),
            }
          : {}),
      });
      return { status: response.status, body: await response.text() };
    },
    { path, mutation },
  );
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
  managed = false,
): Promise<Launch> {
  const directory = join(root, managed ? 'managed-shunt' : `run-${reopen ? 1 : index}`);
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
    kind: managed
      ? reopen
        ? 'managed-reopen'
        : 'managed-fresh'
      : reopen
        ? 'offline-reopen'
        : 'fresh',
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
        ...(managed ? {} : { ATELIER_GATEWAY: fixture.gatewayUrl }),
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
    if (!reopen || managed) {
      await initialProjectDialog.waitFor({
        state: 'visible',
        timeout: Math.max(1, cfg.startupMs - (performance.now() - started)),
      });
      await initialProjectDialog.getByRole('button', { name: '关闭详情', exact: true }).click();
    }
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
      managed,
      'Gateway status must match the isolated launch mode',
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

async function compactBrowserHeader(page: Page) {
  const browser = page.getByRole('region', { name: '桌面浏览器', exact: true });
  const tabbar = browser.locator('.desktop-browser-tabbar');
  const toolbar = browser.locator('.desktop-browser-toolbar');
  for (const name of ['新建标签页', '浏览器设置'])
    assert.equal(await tabbar.getByRole('button', { name, exact: true }).count(), 1);
  assert.equal(await tabbar.getByRole('group', { name: '网页标签', exact: true }).count(), 1);
  for (const name of ['后退', '前进', '刷新网页', '人工接管'])
    assert.equal(await toolbar.getByRole('button', { name, exact: true }).count(), 1);
  assert.equal(await toolbar.getByRole('textbox', { name: '网页地址', exact: true }).count(), 1);
  assert.equal(
    await browser.getByRole('button', { name: '允许 Agent 使用内置浏览器', exact: true }).count(),
    0,
    'Project authorization belongs in the closed settings dialog',
  );
  const bounds = await browser.evaluate((element) => {
    const box = (selector: string) => {
      const target = element.querySelector(selector);
      if (!target) throw new Error(`Missing browser header element ${selector}`);
      const rect = target.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom };
    };
    return {
      tabbar: box('.desktop-browser-tabbar'),
      toolbar: box('.desktop-browser-toolbar'),
      slot: box('.desktop-browser-slot'),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  assert.ok(bounds.tabbar.height > 0 && bounds.toolbar.height > 0 && bounds.slot.height > 0);
  assert.ok(Math.abs(bounds.toolbar.y - bounds.tabbar.bottom) <= 1, 'Header rows must be adjacent');
  assert.ok(Math.abs(bounds.slot.y - bounds.toolbar.bottom) <= 1, 'No third browser header row');
  return { rows: 2, height: bounds.slot.y - bounds.tabbar.y, ...bounds };
}

async function browserSettingsRestored(page: Page, native: Page) {
  const before = await compactBrowserHeader(page);
  await page.getByRole('button', { name: '浏览器设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '浏览器设置', exact: true });
  await dialog.waitFor({ state: 'visible' });
  try {
    // Change the renderer slot while the modal hides the native view. Its new
    // viewport can match this slot only after the host processes restored layout.
    await page.setViewportSize({
      width: before.viewport.width - 24,
      height: before.viewport.height - 24,
    });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    const resized = await compactBrowserHeader(page);
    assert.ok(
      Math.abs(resized.slot.width - before.slot.width) > 2 ||
        Math.abs(resized.slot.height - before.slot.height) > 2,
      'Modal probe must change the native view layout',
    );
    await until(
      async () => {
        const viewport = await native.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        return Math.abs(viewport.width - resized.slot.width) <= 2 &&
          Math.abs(viewport.height - resized.slot.height) <= 2
          ? viewport
          : undefined;
      },
      5000,
      'native view restored with the resized slot after browser settings closes',
    );
    await native
      .getByRole('heading', { name: browserTitle, exact: true })
      .waitFor({ state: 'visible' });
  } finally {
    if (await dialog.isVisible()) {
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
    }
    await page.setViewportSize(before.viewport);
  }
  const restored = await compactBrowserHeader(page);
  const viewport = await until(
    async () => {
      const value = await native.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      return Math.abs(value.width - restored.slot.width) <= 2 &&
        Math.abs(value.height - restored.slot.height) <= 2
        ? value
        : undefined;
    },
    5000,
    'native viewport matches the restored browser slot',
  );
  assert.equal(native.isClosed(), false);
  return { ...restored, nativeViewport: viewport, restoredAfterSettings: true };
}

async function nativeBrowserSdk(
  run: Launch,
  fixture: Fixtures,
  projectId: string,
  sessionId: string,
): Promise<void> {
  evidence.phase = 'native-browser-sdk';
  await save();
  const { page } = run;
  const route = `/api/projects/${projectId}/desktop-browser`;
  const initial = browserAccess(await api(page, route));
  assert.deepEqual(initial, { available: true, enabled: false, revision: null });
  const extensions = await api(page, `/api/projects/${projectId}/extensions`);
  assert.equal(
    array(extensions.items).filter((item) => record(item).kind === 'mcp').length,
    0,
    'Native browser case must start without a configured MCP server',
  );
  const token = string((await api(page, '/api/bootstrap')).csrfToken);
  await page.getByRole('button', { name: '浏览器', exact: true }).click();
  await page.getByRole('button', { name: '浏览器设置', exact: true }).click();
  const browserSettings = page.getByRole('dialog', { name: '浏览器设置', exact: true });
  const enable = browserSettings.getByRole('button', {
    name: '允许 Agent 使用内置浏览器',
    exact: true,
  });
  assert.equal(await enable.getAttribute('aria-pressed'), 'false');
  const [enabledResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && new URL(response.url()).pathname === route,
    ),
    enable.click(),
  ]);
  assert.equal(enabledResponse.status(), 200);
  assert.deepEqual(enabledResponse.request().postDataJSON() as unknown, {
    enabled: true,
    revision: initial.revision,
  });
  const enabled = browserAccess((await enabledResponse.json()) as unknown);
  assert.equal(enabled.available, true);
  assert.equal(enabled.enabled, true);
  assert.ok(enabled.revision, 'Enabling must issue a project authorization revision');
  await until(
    async () => ((await enable.getAttribute('aria-pressed')) === 'true' ? true : undefined),
    5000,
    'browser settings switch reflects project authorization',
  );
  await page.keyboard.press('Escape');
  await browserSettings.waitFor({ state: 'hidden' });
  assert.deepEqual(browserAccess(await api(page, route)), enabled);
  const unchanged = await appFetch(page, route, {
    method: 'PATCH',
    body: { enabled: true, revision: enabled.revision },
    token,
  });
  assert.equal(unchanged.status, 200);
  assert.deepEqual(browserAccess(JSON.parse(unchanged.body) as unknown), enabled);
  const stale = await appFetch(page, route, {
    method: 'PATCH',
    body: { enabled: false, revision: initial.revision },
    token,
  });
  assert.equal(stale.status, 409, 'A stale revision cannot revoke a newer authorization');
  assert.equal(
    record(record(JSON.parse(stale.body) as unknown).error).code,
    'BROWSER_ACCESS_CHANGED',
  );
  assert.deepEqual(browserAccess(await api(page, route)), enabled);

  const sessionRoute = `/api/sessions/${sessionId}`;
  const submit = async (text: string, mode: 'readonly' | 'edit') => {
    const response = await appFetch(page, sessionRoute + '/messages', {
      method: 'POST',
      body: { text, mode, idempotencyKey: randomUUID() },
      token,
    });
    assert.equal(response.status, 202, `Start native browser ${mode} run`);
    return string(record(record(JSON.parse(response.body) as unknown).run).id);
  };
  const snapshot = async (runId: string) => {
    assert.deepEqual(
      fixture.evidence.errors,
      [],
      'Loopback browser fixture must accept SDK requests',
    );
    const state = await api(page, sessionRoute);
    const current = array(state.runs)
      .map((value) => record(value))
      .find((item) => item.id === runId);
    assert.ok(current, 'Native browser run must be persisted');
    if (['failed', 'stopped', 'interrupted'].includes(string(current.status)))
      throw new Error(
        `Native browser run ${string(current.status)}: ${JSON.stringify(current.error)}`,
      );
    return { state, current };
  };
  const complete = (runId: string) =>
    until(
      async () => {
        const { state, current } = await snapshot(runId);
        return current.status === 'completed' ? state : undefined;
      },
      60_000,
      'real packaged SDK native browser round trip',
    );
  const readRunId = await submit(browserReadPrompt, 'readonly');
  const readState = await complete(readRunId);
  assert.equal(
    array(readState.permissions).filter((value) => record(value).runId === readRunId).length,
    0,
  );
  await page.getByText(browserReadAnswer, { exact: true }).waitFor({ state: 'visible' });
  const native = await until(
    async () =>
      run.browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url() === `${fixture.siteUrl}/browser`),
    10_000,
    'SDK-created native browser Chromium target',
  );
  assert.notEqual(native, page, 'SDK browser must use a distinct WebContentsView target');
  await native
    .getByRole('heading', { name: browserTitle, exact: true })
    .waitFor({ state: 'visible' });
  assert.equal(await native.locator('body').getAttribute('data-agent-clicks'), '0');
  const header = await browserSettingsRestored(page, native);

  await page.getByRole('button', { name: '人工接管', exact: true }).click();
  await page.getByRole('button', { name: '交还控制', exact: true }).waitFor({ state: 'visible' });
  await native.getByLabel('Browser handoff input', { exact: true }).fill(browserManualValue);
  assert.equal(
    await native.getByLabel('Browser handoff input', { exact: true }).inputValue(),
    browserManualValue,
  );
  await page.getByRole('button', { name: '交还控制', exact: true }).click();
  await page.getByRole('button', { name: '人工接管', exact: true }).waitFor({ state: 'visible' });

  const editRunId = await submit(browserEditPrompt, 'edit');
  const permission = await until(
    async () => {
      const { state, current } = await snapshot(editRunId);
      const pending = array(state.permissions)
        .map((value) => record(value))
        .find((item) => item.runId === editRunId && item.status === 'pending');
      if (!pending)
        assert.notEqual(current.status, 'completed', 'Browser click must wait for approval');
      return pending;
    },
    60_000,
    'one native browser click approval',
  );
  assert.equal(permission.kind, 'browser');
  const [operation, ...input] = string(permission.command).split('\n');
  assert.equal(operation, 'browser_click');
  assert.deepEqual(JSON.parse(input.join('\n')) as unknown, {
    ref: fixture.evidence.nativeBrowser.refreshedRef,
  });
  assert.equal(
    await native.locator('body').getAttribute('data-agent-clicks'),
    '0',
    'Click must not run before approval',
  );
  assert.equal(
    fixture.evidence.nativeBrowser.editRequests,
    2,
    'SDK must pause at the browser approval',
  );
  const decision = await appFetch(page, `/api/permissions/${string(permission.id)}/decision`, {
    method: 'POST',
    body: { decision: 'allow', version: permission.version },
    token,
  });
  assert.equal(decision.status, 200, 'Paired renderer plus CSRF must allow the browser approval');
  assert.equal(record(record(JSON.parse(decision.body) as unknown).permission).status, 'allowed');
  const editState = await complete(editRunId);
  await page.getByText(browserEditAnswer, { exact: true }).waitFor({ state: 'visible' });
  const permissions = array(editState.permissions)
    .map((value) => record(value))
    .filter((item) => item.runId === editRunId);
  assert.equal(permissions.length, 1, 'Read tools must not create additional approvals');
  assert.equal(permissions[0]?.status, 'allowed');
  assert.equal(native.url(), `${fixture.siteUrl}/browser`);
  assert.equal(
    await native.locator('body').getAttribute('data-agent-clicks'),
    '1',
    'Exactly one approved SDK click must reach the native target',
  );
  await native.getByText('Browser action completed', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(
    await native.getByLabel('Browser handoff input', { exact: true }).inputValue(),
    browserManualValue,
  );
  const browserEvidence = fixture.evidence.nativeBrowser;
  assert.equal(browserEvidence.readRequests, 3);
  assert.equal(browserEvidence.editRequests, 5);
  assert.equal(browserEvidence.clickResultReturned, true);
  assert.ok(browserEvidence.screenshotArtifactId);
  const artifacts = array(editState.artifacts)
    .map((value) => record(value))
    .filter((item) => item.runId === editRunId);
  assert.equal(artifacts.length, 1, 'Screenshot must publish exactly one artifact');
  const artifact = record(artifacts[0], 'native screenshot artifact');
  assert.equal(artifact.id, browserEvidence.screenshotArtifactId);
  assert.equal(artifact.projectId, projectId);
  assert.equal(artifact.sessionId, sessionId);
  assert.equal(artifact.mime, 'image/png');
  assert.equal(artifact.availability, 'available');
  const download = await page.evaluate(
    async (path) => {
      const response = await fetch(path, { signal: AbortSignal.timeout(5000) });
      return {
        status: response.status,
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    },
    `/api/artifacts/${string(artifact.id)}/download`,
  );
  assert.equal(download.status, 200);
  const png = Buffer.from(download.bytes);
  assert.equal(png.length, artifact.size);
  const pixels = bluePixels(png);
  assert.ok(
    pixels.blue > 1000,
    'PNG artifact must show the live page changed by the approved click',
  );
  await writeFile(join(root, 'native-browser-artifact.png'), png, { mode: 0o600 });
  const revokedResponse = await appFetch(page, route, {
    method: 'PATCH',
    body: { enabled: false, revision: enabled.revision },
    token,
  });
  assert.equal(revokedResponse.status, 200);
  const revoked = browserAccess(JSON.parse(revokedResponse.body) as unknown);
  assert.equal(revoked.enabled, false);
  assert.ok(revoked.revision);
  assert.notEqual(revoked.revision, enabled.revision);
  assert.deepEqual(browserAccess(await api(page, route)), revoked);
  evidence.checks.nativeBrowserSdk = {
    realSdk: true,
    transport: 'loopback SSE replacement',
    paidModelCalls: 0,
    noConfiguredMcp: true,
    uiEnable: true,
    staleRevisionRejected: true,
    revoked: true,
    readonlyRun: readRunId,
    editRun: editRunId,
    separateNativeTarget: true,
    header,
    manualTakeoverAndRelease: true,
    reobservedAfterHandoff: true,
    approvals: 1,
    clickCount: 1,
    artifactId: artifact.id,
    png: { bytes: png.length, ...pixels },
    ...browserEvidence,
  };
  await page.getByRole('button', { name: '任务详情', exact: true }).first().click();
  await save();
}

async function automaticToolsSdk(run: Launch, fixture: Fixtures, projectId: string): Promise<void> {
  evidence.phase = 'automatic-tools-sdk';
  await save();
  const { page, directory } = run;
  const token = string((await api(page, '/api/bootstrap')).csrfToken);
  const route = `/api/projects/${projectId}/desktop-browser`;
  const initial = browserAccess(await api(page, route));
  assert.equal(
    initial.enabled,
    false,
    'Manual browser verification must finish by revoking access',
  );
  const enable = await appFetch(page, route, {
    method: 'PATCH',
    body: { enabled: true, revision: initial.revision },
    token,
  });
  assert.equal(enable.status, 200);
  const enabled = browserAccess(JSON.parse(enable.body) as unknown);
  assert.equal(enabled.enabled, true);
  const extensionRoute = `/api/projects/${projectId}/extensions`;
  const created = await appFetch(page, extensionRoute, {
    method: 'POST',
    body: {
      kind: 'mcp',
      name: automaticMcpName,
      enabled: true,
      autoUseInChat: true,
      transport: { type: 'http', url: `${fixture.siteUrl}/mcp` },
    },
    token,
  });
  assert.equal(created.status, 201);
  const extensionId = string(record(record(JSON.parse(created.body) as unknown).item).id);
  const discovery = await appFetch(page, `${extensionRoute}/${extensionId}/test`, {
    method: 'POST',
    body: {},
    token,
  });
  assert.equal(discovery.status, 200);
  const discovered = record(JSON.parse(discovery.body) as unknown);
  assert.equal(discovered.status, 'connected', 'Installed runtime must discover the loopback MCP');
  const extension = record(discovered.item);
  assert.deepEqual(extension.allowedTools, [], 'MCP discovery must not grant tools implicitly');
  assert.ok(array(extension.tools).some((value) => record(value).name === automaticMcpTool));
  // ProjectExtensions accepts grants only after the tool has been discovered.
  const grant = await appFetch(page, `${extensionRoute}/${extensionId}`, {
    method: 'PATCH',
    body: {
      version: extension.version,
      allowedTools: [{ name: automaticMcpTool, access: 'approval' }],
    },
    token,
  });
  assert.equal(grant.status, 200);
  const granted = record(record(JSON.parse(grant.body) as unknown).item);
  assert.deepEqual(granted.allowedTools, [{ name: automaticMcpTool, access: 'approval' }]);
  assert.equal(granted.enabled, true);
  assert.equal(granted.autoUseInChat, true);

  const [newSession] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/sessions',
    ),
    page.getByRole('button', { name: '新建会话', exact: true }).click(),
  ]);
  assert.equal(newSession.status(), 201);
  const session = record(record((await newSession.json()) as unknown).session);
  const sessionId = string(session.id);
  assert.equal(session.projectId, projectId);
  const sessionRoute = `/api/sessions/${sessionId}`;
  const thread = page.locator(`.message-thread[data-session-id="${sessionId}"]`);
  await thread.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '浏览器', exact: true }).click();
  await page.getByRole('button', { name: '人工接管', exact: true }).waitFor({ state: 'visible' });
  const mode = page.getByRole('combobox', { name: '运行模式', exact: true });
  await mode.getByText('只读', { exact: true }).waitFor({ state: 'visible' });
  const file = join(directory, 'project', automaticReceiptName);
  assert.equal((await lstat(join(directory, 'project'))).isSymbolicLink(), false);
  assert.equal(automaticReceiptName.includes('/'), false, 'Receipt stays in the isolated project');
  await assert.rejects(access(file), { code: 'ENOENT' });
  await mode.click();
  await page.getByRole('option', { name: /全工具自动化/ }).click();
  await mode.getByText('全工具自动化', { exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('textbox', { name: '继续对话', exact: true }).fill(automaticPrompt);
  const chat = await thread.evaluateHandle((element) => {
    const selectors =
      '.chat-approval, .tool-card, .chat-tool-call, [data-tool-call-id], [data-tool-id]';
    const violations: string[] = [];
    const inspect = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches(selectors)) violations.push(node.className || node.tagName);
      for (const child of node.querySelectorAll(selectors))
        violations.push(child.className || child.tagName);
    };
    inspect(element);
    const observer = new MutationObserver((records) => {
      for (const mutation of records) {
        inspect(mutation.target);
        for (const node of mutation.addedNodes) inspect(node);
      }
    });
    observer.observe(element, { childList: true, subtree: true, attributes: true });
    return { observer, violations };
  });
  try {
    const [sent] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `${sessionRoute}/messages`,
      ),
      page.getByRole('button', { name: '发送任务', exact: true }).click(),
    ]);
    assert.equal(sent.status(), 202);
    const submitted = record(sent.request().postDataJSON() as unknown);
    assert.equal(submitted.text, automaticPrompt);
    assert.equal(submitted.mode, 'edit');
    assert.equal(submitted.approvalMode, 'automatic');
    const accepted = record(record((await sent.json()) as unknown).run);
    const runId = string(accepted.id);
    assert.equal(accepted.sessionId, sessionId);
    assert.equal(accepted.mode, 'edit');
    assert.equal(accepted.approvalMode, 'automatic');
    assert.equal(accepted.browserRevision, enabled.revision);
    const state = await until(
      async () => {
        assert.deepEqual(
          fixture.evidence.errors,
          [],
          'Loopback automatic fixture must accept SDK requests',
        );
        const state = await api(page, sessionRoute);
        const runs = array(state.runs).map((value) => record(value));
        assert.equal(runs.length, 1, 'Automatic mode must start exactly one isolated run');
        const current = record(runs[0]);
        assert.equal(current.id, runId);
        assert.equal(current.mode, 'edit');
        assert.equal(current.approvalMode, 'automatic');
        assert.notEqual(
          current.status,
          'awaiting_permission',
          'Automatic tools cannot pause for approval',
        );
        for (const value of array(state.permissions))
          assert.notEqual(
            record(value).status,
            'pending',
            'Automatic permissions cannot be pending',
          );
        const requested = array(state.events).filter(
          (value) => record(value).type === 'permission.requested',
        );
        assert.equal(requested.length, 0, 'No transient approval request may be emitted');
        if (['failed', 'stopped', 'interrupted'].includes(string(current.status)))
          throw new Error(
            `Automatic SDK run ${string(current.status)}: ${JSON.stringify(current.error)}`,
          );
        return current.status === 'completed' ? state : undefined;
      },
      60_000,
      'automatic browser, file and MCP real packaged SDK round trip',
    );
    await thread.getByText(automaticAnswer, { exact: true }).waitFor({ state: 'visible' });
    await mode.getByText('全工具自动化', { exact: true }).waitFor({ state: 'visible' });
    const savedDraft = record(record(state.session).draft);
    assert.equal(savedDraft.mode, 'edit');
    assert.equal(savedDraft.approvalMode, 'automatic');
    assert.equal(await thread.locator('.chat-approval').count(), 0);
    assert.equal(await thread.locator('.assistant-message').count(), 1);
    assert.equal(await thread.locator('.user-message').count(), 1);
    const violations = await chat.evaluate(({ observer, violations }) => {
      observer.disconnect();
      return violations;
    });
    assert.deepEqual(violations, [], 'No approval or per-tool cards may appear in automatic chat');
    const permissions = array(state.permissions).map((value) => record(value));
    assert.equal(
      permissions.length,
      3,
      'Browser click, file write and approval MCP each leave an audit record',
    );
    assert.deepEqual(permissions.map((permission) => permission.kind).sort(), [
      'browser',
      'mcp',
      'write',
    ]);
    for (const permission of permissions) {
      assert.equal(permission.runId, runId);
      assert.equal(permission.sessionId, sessionId);
      assert.equal(permission.status, 'allowed');
      assert.equal(permission.decisionSource, 'automatic');
    }
    const writePermission = permissions.find((permission) => permission.kind === 'write');
    assert.equal(writePermission?.path, automaticReceiptName);
    assert.equal(writePermission?.before, null);
    assert.equal(writePermission?.after, automaticReceipt);
    const tools = array(state.tools).map((value) => record(value));
    assert.equal(tools.length, automaticToolCount);
    assert.equal(record(accepted.config).limitExecution, false);
    assert.ok(tools.every((tool) => tool.runId === runId && tool.status === 'succeeded'));
    for (const permission of permissions)
      assert.ok(
        tools.some(
          (tool) => tool.id === permission.toolCallId && tool.permissionId === permission.id,
        ),
      );
    assert.equal((await lstat(file)).isFile(), true);
    assert.equal(await readFile(file, 'utf8'), automaticReceipt);
    const native = run.browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url() === `${fixture.siteUrl}/browser-automatic`);
    assert.ok(
      native && native !== page,
      'Automatic browser action must reach a distinct native target',
    );
    assert.equal(await native.locator('body').getAttribute('data-agent-clicks'), '1');
    await native
      .getByText('Browser action completed', { exact: true })
      .waitFor({ state: 'visible' });
    assert.equal(fixture.evidence.automatic.requests, automaticToolCount + 1);
    assert.equal(fixture.evidence.automatic.clickResultReturned, true);
    assert.equal(fixture.evidence.automatic.writeResultReturned, true);
    assert.equal(fixture.evidence.automatic.mcpResultReturned, true);
    assert.equal(fixture.evidence.automatic.mcpCalls, 1);
    assert.equal(record(state.session).sdkMode, 'edit');
    assert.ok(string(record(state.session).sdkSessionId));
    assert.equal(record(accepted.config).model, model);
    const modelButton = page.getByRole('combobox', { name: '选择模型', exact: true });
    const modelBounds = await modelButton.boundingBox();
    const sendBounds = await page
      .getByRole('button', { name: '发送任务', exact: true })
      .boundingBox();
    assert.ok(
      modelBounds && sendBounds && Math.abs(modelBounds.y - sendBounds.y) < 6,
      'Model picker and send button share the compact toolbar',
    );
    await modelButton.click();
    const models = page.getByRole('listbox');
    const modelOption = models.getByRole('option', { name: /sdk-offline-alternate/ });
    await modelOption.waitFor({ state: 'visible' });
    await page.screenshot({ path: join(root, 'session-model-picker.png') });
    await modelOption.click();
    await models.waitFor({ state: 'hidden' });
    await modelButton
      .getByText(`模型 · ${alternateModel}`, { exact: true })
      .waitFor({ state: 'visible' });
    const effortButton = page.getByRole('combobox', { name: '选择推理深度', exact: true });
    await effortButton.click();
    await page.getByRole('option', { name: '很高', exact: true }).click();
    await effortButton.getByText('深度 · 很高', { exact: true }).waitFor({ state: 'visible' });
    await page
      .getByRole('textbox', { name: '继续对话', exact: true })
      .fill(automaticFollowupPrompt);
    const [followup] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `${sessionRoute}/messages`,
      ),
      page.getByRole('button', { name: '发送任务', exact: true }).click(),
    ]);
    assert.equal(followup.status(), 202);
    const followupRun = record(record((await followup.json()) as unknown).run);
    assert.equal(followupRun.approvalMode, 'automatic');
    assert.equal(followupRun.maxSearchChargeFen, 0);
    assert.equal(record(followupRun.config).model, alternateModel);
    assert.equal(record(followupRun.config).effort, 'xhigh');
    await thread.getByText(automaticFollowupAnswer, { exact: true }).waitFor({ state: 'visible' });
    await mode.getByText('全工具自动化', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(fixture.evidence.automatic.requests, automaticToolCount + 2);
    await mode.click();
    await page.getByRole('listbox').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(root, 'session-mode-menu.png') });
    await page.keyboard.press('Escape');
    await page.screenshot({
      path: join(root, 'automatic-tools-completed.png'),
      mask: [page.locator('.history-meta')],
    });
    evidence.checks.automaticToolsSdk = {
      realSdk: true,
      transport: 'loopback SSE replacement',
      paidModelCalls: 0,
      sessionId,
      runId,
      composerOption: '全工具自动化',
      mode: accepted.mode,
      approvalMode: accepted.approvalMode,
      sessionSelectionPreserved: true,
      followupApprovalMode: followupRun.approvalMode,
      initialModel: model,
      followupModel: alternateModel,
      followupEffort: 'xhigh',
      pendingApprovals: 0,
      chatCardsObserved: violations.length,
      permissions: permissions.map(({ id, kind, status, decisionSource }) => ({
        id,
        kind,
        status,
        decisionSource,
      })),
      file: {
        path: automaticReceiptName,
        bytes: Buffer.byteLength(automaticReceipt),
        verified: true,
      },
      clickCount: 1,
      ...fixture.evidence.automatic,
    };
  } finally {
    await chat.evaluate(({ observer }) => observer.disconnect()).catch(() => {});
    await chat.dispose();
  }
  const revoked = await appFetch(page, route, {
    method: 'PATCH',
    body: { enabled: false, revision: enabled.revision },
    token,
  });
  assert.equal(revoked.status, 200);
  assert.equal(browserAccess(JSON.parse(revoked.body) as unknown).enabled, false);
  const link = thread.getByRole('link', { name: chatLinkLabel, exact: true });
  const chooser = page.getByRole('dialog');
  const destination = `${fixture.siteUrl}${chatLinkPath}`;
  await link.click();
  await chooser.getByRole('button', { name: '在外部浏览器打开', exact: true }).waitFor();
  await page.screenshot({ path: join(root, 'chat-link-chooser.png') });
  await page.keyboard.press('Escape');
  await chooser.waitFor({ state: 'hidden' });
  await until(
    async () =>
      (await link.evaluate((element) => document.activeElement === element)) ? true : undefined,
    3000,
    'focus returned to the message link',
  );
  await link.press('Enter');
  await chooser.getByRole('button', { name: '在外部浏览器打开', exact: true }).click();
  await chooser.waitFor({ state: 'hidden' });
  const externalLog = join(root, 'chat-link-external.txt');
  const external = await until(
    () => readFile(externalLog, 'utf8').catch(() => undefined),
    5000,
    'system browser opener receives the message URL',
  );
  assert.equal(external.trim(), destination);
  assert.ok(
    !run.browser
      .contexts()
      .flatMap((context) => context.pages())
      .some((target) => target.url() === destination),
  );
  await link.click();
  await chooser.getByRole('button', { name: '在内置浏览器打开', exact: true }).click();
  await chooser.waitFor({ state: 'hidden' });
  const nativeTargets = run.browser.contexts().flatMap((context) => context.pages());
  assert.ok(nativeTargets.some((target) => target.url() === destination));
  assert.ok(
    nativeTargets.some((target) => target.url() === `${fixture.siteUrl}/browser-automatic`),
  );
  assert.equal(
    await page.getByRole('textbox', { name: '网页地址', exact: true }).inputValue(),
    destination,
  );
  const rejected = await page.evaluate(async (id) => {
    const bridge = (window as Window & { atelierDesktop?: DesktopBrowserBridge }).atelierDesktop;
    if (!bridge) return false;
    try {
      await bridge.command(id, 'open-external', 'file:///unavailable');
      return false;
    } catch {
      return true;
    }
  }, projectId);
  assert.equal(rejected, true);
  assert.equal(await readFile(externalLog, 'utf8'), external);
  evidence.checks.chatWebLinks = {
    explicitChoice: true,
    keyboardAndFocus: true,
    externalSystemOpenerReceivedUrl: true,
    internalSeparateTab: true,
    protocolRejected: true,
  };
  await save();
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
          .find((candidate) => candidate.url() === `${fixture.siteUrl}/`),
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
    evidence.phase = 'native-browser-download';
    await save();
    const trigger = page.getByRole('button', { name: '浏览器下载', exact: true });
    const dialog = page.getByRole('dialog', { name: '下载', exact: true });
    await trigger.click();
    const destination = await dialog
      .getByRole('region', { name: '下载保存位置' })
      .locator('p')
      .innerText();
    const isolatedHome = join(directory, 'home');
    assert.ok(
      destination === isolatedHome || destination.startsWith(`${isolatedHome}/`),
      'Save folder stays in the isolated profile home',
    );
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, browserDownloadName), 'original file');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await native.getByRole('link', { name: browserDownloadLabel, exact: true }).click();
    await until(
      async () => (fixture.evidence.browserDownloadRequests === 1 ? true : undefined),
      5000,
      'attachment link reaches the local HTTP server',
    );
    await trigger.click();
    const progress = dialog.getByRole('progressbar');
    await progress.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(
      Number(await progress.getAttribute('max')),
      Buffer.byteLength(browserDownloadBody),
    );
    await page.screenshot({ path: join(root, 'native-browser-download-progress.png') });
    await dialog
      .getByText('下载完成', { exact: true })
      .waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: '在文件夹中显示', exact: true }).waitFor();
    await dialog.getByRole('button', { name: '打开下载文件夹', exact: true }).waitFor();
    const saved = join(destination, `${browserDownloadLabel} (1).xls`);
    assert.deepEqual(await readFile(saved), browserDownloadBody);
    assert.equal(await readFile(join(destination, browserDownloadName), 'utf8'), 'original file');
    assert.equal(native.url(), `${fixture.siteUrl}/`);
    await page.screenshot({ path: join(root, 'native-browser-download-completed.png') });
    const previewButton = dialog.getByRole('button', { name: '预览', exact: true });
    await previewButton.click();
    const preview = page.getByRole('dialog', {
      name: `${browserDownloadLabel} (1).xls`,
      exact: true,
    });
    await preview
      .getByText('Suzhou jobs', { exact: true })
      .waitFor({ state: 'visible', timeout: 20_000 });
    await page.screenshot({ path: join(root, 'native-browser-download-preview.png') });
    await preview.getByRole('button', { name: '返回下载列表', exact: true }).click();
    await dialog.getByRole('button', { name: '用系统应用打开', exact: true }).click();
    const openLog = join(root, 'chat-link-external.txt');
    await until(
      async () => {
        const contents = await readFile(openLog, 'utf8').catch(() => '');
        return contents.split('\n').includes(saved) ? true : undefined;
      },
      5000,
      'system-opener receives the downloaded file path',
    );
    const unauthorized = await page.evaluate(
      async ({ project, other }) => {
        const bridge = (window as Window & { atelierDesktop?: DesktopBrowserBridge })
          .atelierDesktop;
        if (!bridge) return false;
        const id = await new Promise<string>((resolve, reject) => {
          const unsubscribe = bridge.subscribe((state) => {
            const file = state.downloads?.find((entry) => entry.status === 'completed');
            if (state.projectId === project && file) {
              unsubscribe();
              resolve(file.id);
            }
          });
          void bridge.command(project, 'state').catch((error: unknown) => {
            unsubscribe();
            reject(error);
          });
        });
        try {
          await bridge.readDownload(other, id);
          return false;
        } catch {
          return true;
        }
      },
      { project: projectId, other: randomUUID() },
    );
    assert.equal(unauthorized, true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    evidence.checks.nativeBrowserDownload = {
      targetBlank: true,
      progressVisible: true,
      systemDownloadsPath: true,
      duplicatePreserved: true,
      readableAttachmentTitle: true,
      originalPageRetained: true,
      folderActionsVisible: true,
      fileVistaWorkbookPreview: true,
      systemOpenerReceivedFile: true,
      crossProjectPreviewRejected: true,
      savedBytes: Buffer.byteLength(browserDownloadBody),
    };
    await page.getByRole('button', { name: '任务详情', exact: true }).first().click();
  }
  evidence.phase = 'packaged-sdk';
  await save();
  fixture.evidence.healthMode = 'online';
  // The ordinary renderer bootstraps gateway status when opening settings.
  await settings(page, false);
  // Edit mode ensures command absence is actually caused by missing bwrap.
  await page.getByRole('combobox', { name: '运行模式', exact: true }).click();
  await page.getByRole('option', { name: /受控修改/ }).click();
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
  await nativeBrowserSdk(run, fixture, projectId, sessionId);
  await automaticToolsSdk(run, fixture, projectId);
  // Address-bar navigation gives control to the user, so test it after the Agent runs.
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
  const mode = run.page.getByRole('combobox', { name: '运行模式', exact: true });
  await mode.getByText('受控修改', { exact: true }).waitFor({ state: 'visible' });
  const automaticId = string(record(evidence.checks.automaticToolsSdk).sessionId);
  const automaticState = await api(run.page, `/api/sessions/${automaticId}`);
  const automaticSession = record(automaticState.session);
  assert.equal(record(automaticSession.draft).approvalMode, 'automatic');
  assert.equal(record(automaticSession.draft).model, alternateModel);
  assert.equal(record(automaticSession.draft).effort, 'xhigh');
  await run.page
    .getByRole('button')
    .filter({
      has: run.page.locator('.history-title', { hasText: string(automaticSession.title) }),
    })
    .click();
  await run.page.getByText(automaticFollowupAnswer, { exact: true }).waitFor({ state: 'visible' });
  await mode.getByText('全工具自动化', { exact: true }).waitFor({ state: 'visible' });
  await run.page
    .getByRole('combobox', { name: '选择模型', exact: true })
    .getByText(`模型 · ${alternateModel}`, { exact: true })
    .waitFor({ state: 'visible' });
  await settings(run.page, true);
  assert.equal(fixture.evidence.requests, 2, 'Offline reopen must make no receipt model request');
  assert.equal(
    fixture.evidence.nativeBrowser.readRequests,
    3,
    'Offline reopen must make no browser read request',
  );
  assert.equal(
    fixture.evidence.nativeBrowser.editRequests,
    5,
    'Offline reopen must make no browser edit request',
  );
  assert.equal(
    fixture.evidence.automatic.requests,
    automaticToolCount + 2,
    'Offline reopen must make no automatic model request',
  );
  assert.equal(
    fixture.evidence.automatic.mcpCalls,
    1,
    'Offline reopen must not replay the approval MCP effect',
  );
  assert.equal(
    await readFile(join(run.directory, 'project', automaticReceiptName), 'utf8'),
    automaticReceipt,
  );
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
    await writeFile(
      '/smoke/empty-path/xdg-open',
      '#!/bin/sh\nprintf \'%s\\n\' "$1" >> /smoke/chat-link-external.txt\n',
      { mode: 0o755 },
    );
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
    evidence.phase = 'managed-shunt';
    await save();
    const verifyGateway = async (run: Launch) => {
      const { config, managedGateway } = await api(run.page, '/api/config');
      const origin = string(record(config).gateway);
      const catalog = await api(run.page, '/api/models');
      const metadata = record(managedGateway);
      assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
      assert.equal(record(config).managedGateway, true);
      assert.equal(metadata.accountPresent, false);
      assert.equal(metadata.externalGateway, 'http://127.0.0.1:3001');
      assert.equal(catalog.routesAvailable, true);
      assert.ok(array(catalog.models).some((entry) => record(entry).provider === 'chatgpt-plan'));
      assert.equal((await fetch(origin + '/v1/models')).status, 401);
      await run.sample();
      assert.ok(
        run.metric.processes.some(
          (proc) => proc.executable === '/opt/atelier/resources/shunt/shunt',
        ),
      );
      return { config, origin, configPath: string(metadata.configPath) };
    };
    active = await launch(cfg, chromium, fixture, freshStarts + 2, false, true);
    const firstGateway = await verifyGateway(active);
    await active.page.getByRole('button', { name: '模型与网关设置', exact: true }).click();
    const gatewaySettings = active.page.getByRole('dialog', {
      name: '模型与网关设置',
      exact: true,
    });
    await gatewaySettings
      .getByRole('button', { name: '登录 ChatGPT', exact: true })
      .waitFor({ state: 'visible' });
    await gatewaySettings.getByText('尚无账户文件', { exact: false }).waitFor({ state: 'visible' });
    await active.page.screenshot({ path: join(root, 'managed-shunt-settings.png') });
    await active.page.keyboard.press('Escape');
    await gatewaySettings.waitFor({ state: 'hidden' });
    const localConfig = await readFile(firstGateway.configPath, 'utf8');
    const marked = localConfig + '\n# installation smoke persistence marker\n';
    await writeFile(firstGateway.configPath, marked);
    const csrf = string((await api(active.page, '/api/bootstrap')).csrfToken);
    const savedModel = 'persistent-gateway-fixture';
    const changed = await appFetch(active.page, '/api/config', {
      method: 'PATCH',
      token: csrf,
      body: { managedGateway: true, gateway: firstGateway.origin, model: savedModel },
    });
    assert.equal(changed.status, 200);
    await active.stop();
    active = await launch(cfg, chromium, fixture, freshStarts + 3, true, true);
    const reopenedGateway = await verifyGateway(active);
    assert.equal(reopenedGateway.configPath, firstGateway.configPath);
    assert.equal(await readFile(reopenedGateway.configPath, 'utf8'), marked);
    assert.equal(record(reopenedGateway.config).model, savedModel);
    await active.stop();
    active = undefined;
    evidence.checks.managedShunt = {
      bundledProcess: true,
      firstStartWithoutAccount: true,
      anonymousInferenceEndpointRejected: true,
      configAndModelPreservedAcrossReopen: true,
      ephemeralLoopbackReadyAfterReopen: true,
      cleanShutdown: true,
    };
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
