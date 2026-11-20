/**
 * @file 在隔离 Electron 中验证浏览器取消、超时和状态恢复。
 * @implementation 用本地页面和调试响应故障验证慢速导航、原页面与未提交输入的保留、超时标签替换、旧请求隔离以及网页进程退出后的恢复。
 * @updated 2026-11-20T22:16:28+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { app, BrowserWindow, type Event, type WebContents } from 'electron';
import { createBrowserController } from '../../desktop/browser/controller.mjs';
import {
  desktopBrowserChannels,
  desktopBrowserProtocolVersion,
  desktopBrowserStateSchema,
  type DesktopBrowserCall,
  type DesktopBrowserState,
} from '../../shared/desktop-browser.js';
import { AppError } from '../../shared/types.js';

function deferred<T>() {
  let resolve = (_value: T): void => {
    throw new Error('Promise executor did not initialize.');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function injectedCommand(contents: WebContents, name: string) {
  const entered = deferred<void>();
  const reply = deferred<unknown>();
  const send = contents.debugger.sendCommand.bind(contents.debugger);
  contents.debugger.sendCommand = (method: string, params?: object, sessionId?: string) => {
    if (method !== name) return send(method, params, sessionId);
    contents.debugger.sendCommand = send;
    entered.resolve();
    return reply.promise;
  };
  return { entered: entered.promise, resolve: reply.resolve };
}

const root = process.argv[2];
assert.ok(root, 'Launch through scripts/smoke-browser-cancellation.mts.');
app.setPath('userData', join(root, 'profile'));
app.setPath('sessionData', join(root, 'profile'));
app.setPath('downloads', join(root, 'downloads'));
app.commandLine.appendSwitch('disable-background-networking');

async function regression() {
  const replacementResponse = deferred<ServerResponse>();
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/replacement') {
      replacementResponse.resolve(response);
      return;
    }
    if (request.url === '/slow') {
      const timer = setTimeout(() => response.end('<title>Slow page succeeded</title>'), 31_000);
      response.once('close', () => clearTimeout(timer));
      return;
    }
    response.end('<title>Cancellation fixture</title><input id="draft"><button>Apply</button>');
  });
  server.listen(0, '127.0.0.1');
  await bounded(
    new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    }),
    3000,
    'Local fixture startup',
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const owner = new BrowserWindow({ show: false });
  const states = new Map<string, DesktopBrowserState>();
  const sendState = owner.webContents.send.bind(owner.webContents);
  owner.webContents.send = (channel: string, ...args: unknown[]) => {
    if (channel === desktopBrowserChannels.state) {
      const state = desktopBrowserStateSchema.parse(args[0]);
      states.set(state.projectId, state);
    }
    sendState(channel, ...args);
  };
  const views: WebContents[] = [];
  const observeContents = (_event: Event, contents: WebContents) => views.push(contents);
  app.on('web-contents-created', observeContents);
  const controller = createBrowserController({
    getWindow: () => owner,
    getOrigin: () => 'http://127.0.0.1:1',
    isStopping: () => false,
  });
  const project = randomUUID();
  const otherProject = randomUUID();
  const runId = randomUUID();
  const header = (projectId = project): Omit<DesktopBrowserCall, 'name' | 'args'> => ({
    type: 'desktop-browser-call',
    protocolVersion: desktopBrowserProtocolVersion,
    id: randomUUID(),
    projectId,
    runId,
    allowedOrigins: [origin],
  });
  const navigate = (path: string, projectId = project) =>
    controller.runTool({
      ...header(projectId),
      name: 'browser_navigate',
      args: { url: origin + path },
    });
  const snapshot = (): DesktopBrowserCall => ({
    ...header(),
    name: 'browser_snapshot',
    args: {},
  });
  const state = (projectId = project) => {
    const value = states.get(projectId);
    assert.ok(value);
    return value;
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);

  try {
    await bounded(
      assert.rejects(controller.runTool(snapshot()), /当前标签尚未打开网页，请先打开网址。/u),
      1500,
      'Blank snapshot',
    );
    assert.equal(state().busy, false);
    await navigate('/original');
    const original = views[0];
    assert.ok(original && views.length === 1 && state().agentTabId);
    const originalTabId = state().agentTabId;
    const partition = original.session;
    await original.executeJavaScript("document.querySelector('#draft').value = 'unsaved draft'");

    const stalledRead = injectedCommand(original, 'Accessibility.getFullAXTree');
    const read = snapshot();
    const canceledRead = assert.rejects(controller.runTool(read), /网页操作已取消/u);
    await bounded(stalledRead.entered, 2000, 'Read stall');
    assert.equal(state().busy, true);
    controller.cancel(read.id);
    await bounded(canceledRead, 1000, 'Read cancellation');
    assert.equal(state().busy, false);
    assert.equal(state().agentTabId, originalTabId);
    assert.equal(original.getURL(), origin + '/original');
    assert.equal(
      await original.executeJavaScript("document.querySelector('#draft').value"),
      'unsaved draft',
    );
    stalledRead.resolve({ nodes: [{ name: { value: 'STALE SNAPSHOT' } }] });

    const fresh = await controller.runTool(snapshot());
    assert.doesNotMatch(fresh.text ?? '', /STALE SNAPSHOT/u);
    const buttonRef = /"ref":"(r\d+-\d+)","role":"button","name":"Apply"/u.exec(
      fresh.text ?? '',
    )?.[1];
    assert.ok(buttonRef);
    const stalledInput = injectedCommand(original, 'Input.dispatchMouseEvent');
    const click: DesktopBrowserCall = {
      ...header(),
      name: 'browser_click',
      args: { ref: buttonRef },
    };
    const startedAt = performance.now();
    const clickFailure = assert.rejects(controller.runTool(click), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'DESKTOP_BROWSER_TIMEOUT');
      assert.match(error.message, /30 秒内未完成。旧标签未响应，已换成空白标签。/u);
      assert.match(error.message, /网站可能已收到操作。请先核对结果/u);
      return true;
    });
    await bounded(stalledInput.entered, 5000, 'Input stall');
    console.log('Real Electron: input acknowledgement held, testing the 30-second deadline.');
    const originalDestroyed = deferred<void>();
    original.once('destroyed', () => originalDestroyed.resolve());
    const slowStarted = performance.now();
    const slow = navigate('/slow', otherProject);
    const [, slowResult] = await Promise.all([
      bounded(clickFailure, 35_000, 'Input deadline and retirement'),
      bounded(slow, 36_000, 'Slow navigation crosses old deadline'),
    ]);
    const elapsedMs = Math.round(performance.now() - slowStarted);
    assert.ok(elapsedMs >= 31_000);
    assert.match(slowResult.text ?? '', /Slow page succeeded/u);
    await bounded(originalDestroyed.promise, 1500, 'Original view destruction');
    const replacementTabId = state().agentTabId;
    assert.ok(replacementTabId && replacementTabId !== originalTabId);
    assert.equal(state().busy, false);
    assert.equal(state().url, '');
    const replacement = views[2];
    const other = views[1];
    assert.ok(replacement && other);
    assert.equal(other.getURL(), origin + '/slow');
    assert.equal(replacement.session, partition);

    const pending = navigate('/replacement');
    const response = await bounded(
      replacementResponse.promise,
      3000,
      'Replacement navigation starts',
    );
    stalledInput.resolve({});
    controller.cancel(click.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(state().busy, true);
    assert.equal(state().agentTabId, replacementTabId);
    response.end('<title>Replacement ready</title>');
    assert.match((await pending).text ?? '', /Replacement ready/u);
    assert.equal(state().busy, false);

    const stalledCrash = injectedCommand(replacement, 'Accessibility.getFullAXTree');
    const crashFailure = assert.rejects(controller.runTool(snapshot()), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'DESKTOP_BROWSER_RENDERER_GONE');
      return true;
    });
    await bounded(stalledCrash.entered, 2000, 'Crash target in flight');
    const rendererPid = replacement.getOSProcessId();
    assert.ok(rendererPid > 1 && rendererPid !== process.pid);
    assert.notEqual(rendererPid, other.getOSProcessId());
    // Terminate only the fixture renderer, without generating a system core dump.
    process.kill(rendererPid, 'SIGKILL');
    await bounded(crashFailure, 5000, 'Renderer crash detection');
    assert.equal(state().busy, false);
    assert.notEqual(state().agentTabId, replacementTabId);
    assert.equal(other.isDestroyed(), false);
    assert.match((await navigate('/recovered')).text ?? '', /\/recovered/u);
    assert.deepEqual(unhandled, []);
    console.log(
      JSON.stringify({
        realWebContentsView: true,
        blankSnapshotGuidance: true,
        readCancellationPreservesPageAndDraft: true,
        slowNavigationMs: elapsedMs,
        inputTimeoutAndReplacement: true,
        inputTimeoutObservedElapsedMs: Math.round(slowStarted - startedAt) + elapsedMs,
        unrelatedProjectPreserved: true,
        lateRepliesIgnored: true,
        rendererCrashDetectedAndRecovered: true,
        paidModelCalls: 0,
      }),
    );
  } finally {
    controller.reset();
    app.off('web-contents-created', observeContents);
    process.off('unhandledRejection', onUnhandled);
    owner.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void app
  .whenReady()
  .then(regression)
  .then(
    () => app.exit(0),
    (error: unknown) => {
      console.error(error);
      app.exit(1);
    },
  );
