/**
 * @file 验证真实桌面终端并记录允许的系统 shell 身份。
 * @implementation 通过正常面板操作验证 PTY、隐藏、尺寸、刷新和退出；进程例外绑定 PID、启动时刻和可执行文件。
 * @updated 2026-11-26T01:30:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page, WebSocket as BrowserWebSocket } from 'playwright-core';
import {
  terminalCapabilitiesSchema,
  terminalListResponseSchema,
  terminalStreamPath,
  type TerminalRecord,
} from '../../shared/terminal.js';
import { until, type ProcessSample } from './contracts.mjs';

export interface TerminalProcessIdentity {
  pid: number;
  startTicks: string;
  executable: string;
}

export function allowTerminalShell(
  pid: number,
  sidecarPid: number,
  processes: readonly ProcessSample[],
): TerminalProcessIdentity {
  const shell = processes.find((row) => row.pid === pid);
  assert.ok(shell, 'The terminal shell must be observed in the process namespace');
  assert.equal(
    shell.parent,
    sidecarPid,
    'The terminal shell must be a direct child of its sidecar',
  );
  assert.ok(isAbsolute(shell.executable), 'The terminal shell executable must be absolute');
  return { pid: shell.pid, startTicks: shell.startTicks, executable: shell.executable };
}

export function installedOrTerminalProcess(
  process: TerminalProcessIdentity,
  allowed: readonly TerminalProcessIdentity[],
): boolean {
  return (
    process.executable.startsWith('/opt/atelier/') ||
    allowed.some(
      (shell) =>
        shell.pid === process.pid &&
        shell.startTicks === process.startTicks &&
        shell.executable === process.executable,
    )
  );
}

export interface TerminalSmokeOptions {
  page: Page;
  sessionId: string;
  initialCwd: string;
  screenshotDirectory: string;
  observeShell(pid: number): Promise<TerminalProcessIdentity>;
  shellExited(shell: TerminalProcessIdentity): Promise<boolean>;
  resizeWindow?(width: number, height: number): Promise<void>;
}

async function api(page: Page, path: string): Promise<unknown> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Terminal smoke HTTP ${response.status}: ${path}`);
    const value: unknown = await response.json();
    return value;
  }, path);
}

export async function runTerminalSmoke(options: TerminalSmokeOptions) {
  const { page, sessionId, initialCwd, screenshotDirectory } = options;
  const capabilities = terminalCapabilitiesSchema.parse(
    await api(page, '/api/terminals/capabilities'),
  );
  assert.equal(capabilities.supported, true, capabilities.reason);
  const labels = (await page.locator('html').getAttribute('lang'))?.startsWith('en')
    ? {
        open: 'Terminal',
        create: 'New terminal',
        hide: 'Hide terminal panel',
        notice: 'Terminal connection notice',
        close: 'Close terminal 1',
      }
    : {
        open: '终端',
        create: '新建终端',
        hide: '收起终端面板',
        notice: '终端连接提醒',
        close: '关闭终端 1',
      };
  let connections = 0;
  const countConnection = (socket: BrowserWebSocket): void => {
    if (new URL(socket.url()).pathname === terminalStreamPath) connections++;
  };
  page.on('websocket', countConnection);
  const panel = page.locator('.terminal-panel');
  const marker = `AT${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const recordName = `.terminal-smoke-${marker}`;
  const recordPath = join(initialCwd, recordName);
  const list = async () =>
    terminalListResponseSchema.parse(await api(page, `/api/sessions/${sessionId}/terminals`));
  const current = (terminal: TerminalRecord) =>
    panel.locator(`.terminal-viewport[data-terminal-id="${terminal.terminalId}"]`);
  async function input(terminal: TerminalRecord, text: string): Promise<void> {
    const textarea = current(terminal).locator('.xterm-helper-textarea');
    await until(
      async () => ((await textarea.isEditable()) ? true : undefined),
      10_000,
      'Terminal input ready',
    );
    await textarea.focus();
    await page.keyboard.insertText(text);
    await page.keyboard.press('Enter');
  }
  async function rendered(terminal: TerminalRecord, text: string): Promise<void> {
    await until(
      async () => {
        const output = await current(terminal).locator('.xterm-rows').innerText();
        return output.replace(/\s/gu, '').includes(text.replace(/\s/gu, '')) ? true : undefined;
      },
      10_000,
      `Terminal rendered ${text}`,
    );
  }
  async function newRunning(previous: ReadonlySet<string>): Promise<TerminalRecord> {
    return until(
      async () => {
        const created = (await list()).terminals.filter((item) => !previous.has(item.terminalId));
        assert.ok(created.length <= 1, 'A single explicit action must not create two Terminals');
        return created.find((item) => item.state === 'running');
      },
      10_000,
      'A single new Terminal reaches running after ready',
    );
  }
  async function create(): Promise<TerminalRecord> {
    const previous = new Set((await list()).terminals.map((item) => item.terminalId));
    await panel.getByRole('button', { name: labels.create, exact: true }).click();
    return newRunning(previous);
  }
  async function identify(
    terminal: TerminalRecord,
    suffix: string,
  ): Promise<TerminalProcessIdentity> {
    const name = `${recordName}-${suffix}`;
    const path = join(initialCwd, name);
    await input(
      terminal,
      `printf '%s\\n' "$$" "$PWD" > '${name}'; test -t 0 && test -t 1 && printf '\\n%s_TTY_OK\\n' '${marker}'`,
    );
    await rendered(terminal, `${marker}_TTY_OK`);
    const identity = await until(
      async () => {
        const text = await readFile(path, 'utf8').catch(() => undefined);
        if (text === undefined) return undefined;
        const [pid, cwd] = text.trimEnd().split('\n');
        if (!pid || !cwd) return undefined;
        assert.equal(cwd, initialCwd);
        assert.match(pid, /^[1-9]\d*$/u);
        return { pid: Number(pid), cwd };
      },
      5000,
      'Shell PID and initial directory receipt',
    );
    return options.observeShell(identity.pid);
  }
  try {
    await page.goto(new URL(`/#/sessions/${sessionId}/terminal`, page.url()).href);
    const emptyLabel =
      labels.open === 'Terminal' ? 'This session has no terminals yet.' : '当前会话还没有终端。';
    await panel.getByText(emptyLabel, { exact: true }).waitFor();
    await panel.getByRole('button', { name: labels.hide, exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(
      await page
        .getByText(emptyLabel, { exact: true })
        .isVisible()
        .catch(() => false),
      false,
    );
    await page.goto(new URL(`/#/sessions/${sessionId}`, page.url()).href);
    const beforeOpen = new Set((await list()).terminals.map((item) => item.terminalId));
    await page.getByRole('button', { name: labels.open, exact: true }).click();
    await panel.getByRole('button', { name: labels.hide, exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(
      await page
        .getByText(emptyLabel, { exact: true })
        .isVisible()
        .catch(() => false),
      false,
    );
    await page.getByRole('button', { name: labels.open, exact: true }).click();
    const first = await newRunning(beforeOpen);
    assert.equal(first.runtimeId, capabilities.runtimeId);
    assert.equal(first.initialCwd, initialCwd);
    const firstShell = await identify(first, 'first');
    await input(
      first,
      `ATELIER_PROBE_VALUE='${marker}'; printf '\\n%s 中文输入 ✓\\n' "$ATELIER_PROBE_VALUE"`,
    );
    await rendered(first, `${marker} 中文输入 ✓`);
    assert.equal(await panel.locator('.terminal-metadata').count(), 0);
    assert.equal(await panel.getByRole('button', { name: labels.notice, exact: true }).count(), 0);
    const second = await create();
    const secondShell = await identify(second, 'second');
    await panel.locator('.terminal-tab').first().locator('button[aria-pressed]').click();
    await panel
      .getByRole('button', {
        name: labels.open === 'Terminal' ? 'Close terminal 2' : '关闭终端 2',
        exact: true,
      })
      .click();
    await until(
      async () =>
        !(await list()).terminals.some((item) => item.terminalId === second.terminalId)
          ? true
          : undefined,
      10_000,
      'Closing a background tab removes only that Terminal',
    );
    await until(
      async () => ((await options.shellExited(secondShell)) ? true : undefined),
      10_000,
      'Closing a tab exits its shell',
    );
    assert.ok((await list()).terminals.some((item) => item.terminalId === first.terminalId));
    await current(first).locator('.xterm-rows').waitFor();
    const colors = await current(first).evaluate((view) => {
      const client = view.querySelector('.terminal-client');
      const viewport = view.querySelector('.xterm-viewport');
      if (!client || !viewport) throw new Error('Terminal surface unavailable');
      return {
        client: getComputedStyle(client).backgroundColor,
        viewport: getComputedStyle(viewport).backgroundColor,
      };
    });
    assert.notEqual(colors.client, 'rgba(0, 0, 0, 0)', 'Terminal surface must be opaque');
    assert.equal(colors.viewport, colors.client, 'Terminal scroll background follows the theme');
    assert.equal(
      await panel.evaluate((element) => getComputedStyle(element).backgroundColor),
      colors.client,
      'Terminal panel covers the workspace with the same theme surface',
    );
    if (options.resizeWindow) {
      await options.resizeWindow(1000, 700);
      await until(
        async () => ((await panel.getAttribute('data-expanded')) !== null ? true : undefined),
        5000,
        'A narrow desktop window expands the Terminal panel',
      );
      const expanded = await panel.boundingBox();
      assert.ok(expanded && expanded.x === 0 && expanded.width >= 1000);
      assert.equal(
        await panel.evaluate((element) => getComputedStyle(element).backgroundColor),
        colors.client,
      );
      await options.resizeWindow(1440, 900);
      await until(
        async () => ((await panel.getAttribute('data-expanded')) === null ? true : undefined),
        5000,
        'A wide desktop window docks the Terminal panel',
      );
      const docked = await until(
        async () => {
          const bounds = await panel.boundingBox();
          return bounds && bounds.x > 0 && bounds.width > 0 ? bounds : undefined;
        },
        5000,
        'Docked Terminal stays in its own pane',
      );
      assert.ok(docked.x + docked.width <= 1441);
      await panel.getByRole('button', { name: labels.hide, exact: true }).click();
      await panel.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: labels.open, exact: true }).click();
      await current(first).locator('.xterm-rows').waitFor();
    }
    await page.screenshot({ path: join(screenshotDirectory, 'terminal-input.png') });

    const oldSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const beforeResize = (await list()).terminals.find(
      (item) => item.terminalId === first.terminalId,
    );
    assert.ok(beforeResize);
    await page.setViewportSize({ width: oldSize.width + 240, height: oldSize.height + 80 });
    const resized = await until(
      async () =>
        (await list()).terminals.find(
          (item) =>
            item.terminalId === first.terminalId &&
            (item.cols !== beforeResize.cols || item.rows !== beforeResize.rows),
        ),
      10_000,
      'Visible Terminal sends a nonzero resize',
    );
    assert.ok(resized.cols >= 2 && resized.rows >= 1);

    const hiddenConnections = connections;
    await input(
      first,
      `while ! test -f '${recordName}-release'; do :; done; printf '\\n%s_HIDDEN\\n' "$ATELIER_PROBE_VALUE"`,
    );
    await panel.getByRole('button', { name: labels.hide, exact: true }).click();
    await writeFile(`${recordPath}-release`, 'release');
    await delay(150);
    await page.getByRole('button', { name: labels.open, exact: true }).click();
    await rendered(first, `${marker}_HIDDEN`);
    assert.equal(connections, hiddenConnections, 'Hiding must retain the same Terminal WebSocket');

    await input(first, 'while :; do :; done');
    await delay(100);
    await page.keyboard.press('Control+c');
    await input(first, 'printf "\\n%s_INTERRUPT_OK\\n" "$ATELIER_PROBE_VALUE"');
    await rendered(first, `${marker}_INTERRUPT_OK`);
    await input(
      first,
      'i=0; while test "$i" -lt 12000; do printf "terminal-output-%s-........................................\\n" "$i"; i=$((i+1)); done; printf "\\n%s_BURST_DONE\\n" "$ATELIER_PROBE_VALUE"',
    );
    await rendered(first, `${marker}_BURST_DONE`);

    await page.reload();
    const afterReload = await until(
      async () => {
        const response = await list();
        assert.equal(response.runtimeId, first.runtimeId);
        return response.terminals.find(
          (item) => item.terminalId === first.terminalId && item.state === 'running',
        );
      },
      10_000,
      'Reload retains the same Terminal resource',
    );
    await rendered(afterReload, `${marker}_BURST_DONE`);
    assert.equal(await panel.getByRole('button', { name: labels.notice, exact: true }).count(), 0);
    await input(
      afterReload,
      `printf '%s\\n' "$$" "$ATELIER_PROBE_VALUE" > '${recordName}-reload'; printf '\\n%s_RELOADED\\n' "$ATELIER_PROBE_VALUE"`,
    );
    await rendered(afterReload, `${marker}_RELOADED`);
    assert.equal(await readFile(`${recordPath}-reload`, 'utf8'), `${firstShell.pid}\n${marker}\n`);
    await page.screenshot({ path: join(screenshotDirectory, 'terminal-reloaded.png') });

    await panel.getByRole('button', { name: labels.close, exact: true }).click();
    await until(
      async () =>
        !(await list()).terminals.some((item) => item.terminalId === first.terminalId)
          ? true
          : undefined,
      10_000,
      'Explicit Terminal close removes its record',
    );
    await until(
      async () => ((await options.shellExited(firstShell)) ? true : undefined),
      10_000,
      'Explicit Terminal close exits its shell',
    );

    const natural = await create();
    const naturalShell = await identify(natural, 'natural');
    await input(natural, 'exit 7');
    const exited = await until(
      async () =>
        (await list()).terminals.find(
          (item) => item.terminalId === natural.terminalId && item.state === 'exited',
        ),
      10_000,
      'Natural shell exit retains a read-only screen',
    );
    assert.equal(exited.exitCode, 7);
    await until(
      async () => ((await options.shellExited(naturalShell)) ? true : undefined),
      5000,
      'Natural shell process exited',
    );

    const shutdown = await create();
    const shutdownShell = await identify(shutdown, 'shutdown');
    await page.setViewportSize(oldSize);
    return {
      runtimeId: first.runtimeId,
      terminalId: first.terminalId,
      initialCwd,
      tty: true,
      unicodeInput: true,
      resize: { cols: resized.cols, rows: resized.rows },
      hiddenConnectionRetained: true,
      ctrlC: true,
      highOutputRows: 12000,
      reloadSameShellAndVariable: true,
      explicitCloseExited: true,
      naturalExitCode: exited.exitCode,
      shutdownTerminalId: shutdown.terminalId,
      observedShells: [firstShell, naturalShell, shutdownShell],
      shutdownShellLeftRunningForAppExit: true,
    };
  } finally {
    page.off('websocket', countConnection);
  }
}
