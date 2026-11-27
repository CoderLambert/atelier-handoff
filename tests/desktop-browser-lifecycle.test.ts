/**
 * @file 验证原生浏览器操作生命周期管理与 CDP 无障碍/输入驱动。
 * @implementation 覆盖只读取消、交互超时替身、输入已派发警告前缀、崩溃标签恢复以及 withExpectedKey/Mouse 在异常退出时的钩子清理。
 * @updated 2026-11-27T22:00:00+08:00
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  executeCdpClick,
  executeCdpFillForm,
  executeCdpHover,
  executeCdpPressKey,
  executeCdpScreenshot,
  executeCdpScroll,
  executeCdpSelectOption,
  executeCdpType,
  executeCdpWaitFor,
  formatPendingDialogNotice,
  parseJavascriptDialogOpening,
  snapshotAccessibilityTree,
  type BrowserRefTarget,
  type CdpExpectedInputHooks,
} from '../desktop/browser/cdp-driver.mjs';
import {
  runBrowserOperation,
  type BrowserOperationHandle,
} from '../desktop/browser/operation-lifecycle.mjs';
import { executeBrowserTool } from '../desktop/browser/tool-executor.mjs';
import {
  desktopBrowserCallSchema,
  desktopBrowserProtocolVersion,
  isDesktopBrowserInputTool,
  isDesktopBrowserReadOnlyTool,
} from '../shared/desktop-browser.js';
import { AppError } from '../shared/errors.js';

describe('runBrowserOperation', () => {
  test('abandons read-only operation immediately on cancel without replacing the tab', async () => {
    let handle: BrowserOperationHandle | undefined;
    let stopReadOnlyCalls = 0;
    let replaceCalls = 0;
    let finallyCalls = 0;

    const pending = runBrowserOperation({
      id: 'op-read-cancel',
      timeoutMs: 5_000,
      readOnly: true,
      attachHandle: (next) => {
        handle = next;
      },
      isCurrentOperation: () => true,
      canAct: () => true,
      isRendererCrashed: () => false,
      onAbortCleanup: () => {},
      onStopReadOnly: () => {
        stopReadOnlyCalls += 1;
      },
      onReplaceStuckTab: () => {
        replaceCalls += 1;
      },
      onRendererCrashed: () => {},
      onBeforeRun: () => {},
      onFinally: () => {
        finallyCalls += 1;
      },
      execute: ({ waitForNative }) => waitForNative(new Promise(() => {})),
    });

    assert.ok(handle);
    handle.abort.abort();

    await assert.rejects(() => pending, /网页操作已取消/);
    await handle.done;
    assert.equal(stopReadOnlyCalls, 1);
    assert.equal(replaceCalls, 0);
    assert.equal(finallyCalls, 1);

    // Late retire after completion is a harmless no-op.
    handle.retire(new Error('late'));
  });

  test('times out non-read-only operation, stops navigate, replaces stuck tab, and appends verifyInput warning', async () => {
    let handle: BrowserOperationHandle | undefined;
    let stopNavigateCalls = 0;
    let replaceCalls = 0;

    const pending = runBrowserOperation({
      id: 'op-nav-timeout',
      timeoutMs: 25,
      stopGraceMs: 15,
      readOnly: false,
      isNavigate: true,
      attachHandle: (next) => {
        handle = next;
      },
      isCurrentOperation: () => true,
      canAct: () => true,
      isRendererCrashed: () => false,
      onAbortCleanup: () => {},
      onStopNavigate: () => {
        stopNavigateCalls += 1;
      },
      onReplaceStuckTab: () => {
        replaceCalls += 1;
        handle?.retire();
      },
      onRendererCrashed: () => {},
      onBeforeRun: () => {},
      onFinally: () => {},
      execute: ({ waitForNative, markInputDispatched }) => {
        markInputDispatched();
        return waitForNative(new Promise(() => {}));
      },
    });

    await assert.rejects(
      () => pending,
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'DESKTOP_BROWSER_TIMEOUT');
        assert.equal(error.status, 504);
        assert.match(error.message, /旧标签未响应，已换成空白标签/);
        assert.match(error.message, /网站可能已收到操作/);
        return true;
      },
    );
    assert.equal(stopNavigateCalls, 1);
    assert.equal(replaceCalls, 1);
  });

  test('reports DESKTOP_BROWSER_RENDERER_GONE when renderer crashes with verifyInput suffix', async () => {
    let handle: BrowserOperationHandle | undefined;
    let crashReplaced = 0;

    const pending = runBrowserOperation({
      id: 'op-crash',
      timeoutMs: 5_000,
      readOnly: false,
      attachHandle: (next) => {
        handle = next;
      },
      isCurrentOperation: () => true,
      canAct: () => true,
      isRendererCrashed: () => true,
      onAbortCleanup: () => {},
      onReplaceStuckTab: () => {},
      onRendererCrashed: (error) => {
        crashReplaced += 1;
        handle?.retire(error);
      },
      onBeforeRun: () => {},
      onFinally: () => {},
      execute: async ({ markInputDispatched }) => {
        markInputDispatched();
        throw new Error('underlying IPC broken');
      },
    });

    await assert.rejects(
      () => pending,
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'DESKTOP_BROWSER_RENDERER_GONE');
        assert.equal(error.status, 502);
        assert.match(error.message, /网站可能已收到操作/);
        return true;
      },
    );
    assert.equal(crashReplaced, 1);
  });
});

describe('cdp-driver', () => {
  test('builds hierarchical tree snapshot, preserves state attributes, prunes noise, and tracks editable refs', async () => {
    const refs = new Map<string, BrowserRefTarget>();
    const result = await snapshotAccessibilityTree({
      revision: 3,
      url: 'https://example.test/form',
      title: 'Form',
      refs,
      send: async () => ({
        nodes: [
          {
            nodeId: 'n0',
            role: { value: 'RootWebArea' },
            childIds: ['n1'],
          },
          {
            nodeId: 'n1',
            role: { value: 'main' },
            backendDOMNodeId: 100,
            childIds: ['n2', 'n3', 'n4', 'n5', 'n6'],
          },
          {
            nodeId: 'n2',
            ignored: true,
            backendDOMNodeId: 11,
            role: { value: 'button' },
            name: { value: 'Hidden' },
          },
          {
            nodeId: 'n3',
            role: { value: 'generic' },
            childIds: ['n3a'],
          },
          {
            nodeId: 'n3a',
            role: { value: 'textbox' },
            name: { value: 'Email' },
            value: { value: 'a@b.test' },
            backendDOMNodeId: 12,
            properties: [{ name: 'required', value: { value: true } }],
          },
          {
            nodeId: 'n4',
            role: { value: 'combobox' },
            name: { value: 'Country' },
            backendDOMNodeId: 13,
            properties: [{ name: 'expanded', value: { value: false } }],
          },
          {
            nodeId: 'n5',
            role: { value: 'checkbox' },
            name: { value: 'Agree' },
            backendDOMNodeId: 14,
            properties: [{ name: 'checked', value: { value: 'true' } }],
          },
          {
            nodeId: 'n6',
            role: { value: 'button' },
            name: { value: 'Save' },
            backendDOMNodeId: 15,
            properties: [{ name: 'disabled', value: { value: true } }],
            childIds: ['n6a'],
          },
          {
            nodeId: 'n6a',
            role: { value: 'StaticText' },
            name: { value: 'Save' },
          },
        ],
      }),
    });

    assert.match(result.text, /^url: https:\/\/example\.test\/form\ntitle: Form\n/);
    assert.match(result.text, /- main \[ref=r3-1\]/);
    assert.match(result.text, /  - textbox "Email" \[ref=r3-2\] \[value="a@b\.test"\] \[required\]/);
    assert.match(result.text, /  - combobox "Country" \[ref=r3-3\] \[collapsed\]/);
    assert.match(result.text, /  - checkbox "Agree" \[ref=r3-4\] \[checked\]/);
    assert.match(result.text, /  - button "Save" \[ref=r3-5\] \[disabled\]/);
    assert.doesNotMatch(result.text, /Hidden/);
    assert.doesNotMatch(result.text, /    - text "Save"/);
    assert.deepEqual(refs.get('r3-2'), { id: 12, editable: true, role: 'textbox' });
    assert.deepEqual(refs.get('r3-3'), { id: 13, editable: true, role: 'combobox' });
    assert.deepEqual(refs.get('r3-5'), { id: 15, editable: false, role: 'button' });
  });

  test('always clears expectedKey and expectedMouse hooks when CDP send fails', async () => {
    const hooks: CdpExpectedInputHooks = {};
    const refs = new Map<string, BrowserRefTarget>([
      ['r1-1', { id: 42, editable: true, role: 'textbox' }],
      ['r1-2', { id: 99, editable: false, role: 'button' }],
    ]);

    let sawKeyHook = false;
    await assert.rejects(
      () =>
        executeCdpType(
          {
            refs,
            hooks,
            send: async (method) => {
              if (method === 'Input.dispatchKeyEvent') {
                sawKeyHook = Boolean(hooks.expectedKey);
                throw new Error('key-failed');
              }
              return {};
            },
          },
          'r1-1',
          'hello',
          true,
        ),
      /key-failed/,
    );
    assert.equal(sawKeyHook, true);
    assert.equal(hooks.expectedKey, undefined);

    let sawMouseHook = false;
    await assert.rejects(
      () =>
        executeCdpClick(
          {
            refs,
            hooks,
            send: async (method) => {
              if (method === 'DOM.getContentQuads') {
                return { quads: [[10, 10, 30, 10, 30, 30, 10, 30]] };
              }
              if (method === 'Input.dispatchMouseEvent') {
                sawMouseHook = Boolean(hooks.expectedMouse);
                throw new Error('mouse-failed');
              }
              return {};
            },
          },
          'r1-2',
        ),
      /mouse-failed/,
    );
    assert.equal(sawMouseHook, true);
    assert.equal(hooks.expectedMouse, undefined);
  });

  test('prefers getContentQuads, dispatches mouseMoved before click, and supports zoom tolerance', async () => {
    const hooks: CdpExpectedInputHooks = {};
    const refs = new Map<string, BrowserRefTarget>([
      ['r1-1', { id: 7, editable: false, role: 'button' }],
    ]);
    const events: string[] = [];

    await executeCdpClick(
      {
        refs,
        hooks,
        zoomFactor: () => 1.5,
        send: async (method, params) => {
          if (method === 'DOM.getContentQuads') {
            return { quads: [[0, 0, 0, 0, 0, 0, 0, 0], [100, 200, 140, 200, 140, 240, 100, 240]] };
          }
          if (method === 'Input.dispatchMouseEvent') {
            const p = params as { type: string; x: number; y: number; button: string };
            events.push(`${p.type}@${p.x},${p.y}:${p.button}`);
            assert.ok(hooks.expectedMouse);
            assert.equal(
              hooks.expectedMouse({
                type:
                  p.type === 'mouseMoved'
                    ? 'mouseMove'
                    : p.type === 'mousePressed'
                      ? 'mouseDown'
                      : 'mouseUp',
                x: Math.round(p.x * 1.5),
                y: Math.round(p.y * 1.5),
                button: p.button as 'left',
              } as never),
              true,
            );
          }
          return {};
        },
      },
      'r1-1',
      { button: 'right' },
    );

    assert.deepEqual(events, [
      'mouseMoved@120,220:none',
      'mousePressed@120,220:right',
      'mouseReleased@120,220:right',
    ]);
  });

  test('supports platform select-all, empty-text clear with Backspace, and clear=false append', async () => {
    const hooks: CdpExpectedInputHooks = {};
    const refs = new Map<string, BrowserRefTarget>([
      ['r1-1', { id: 5, editable: true, role: 'textbox' }],
    ]);
    const calls: Array<{ method: string; params?: object }> = [];

    await executeCdpType(
      {
        refs,
        hooks,
        platform: 'darwin',
        send: async (method, params) => {
          calls.push({ method, params });
          return {};
        },
      },
      'r1-1',
      '',
      { clear: true },
    );

    assert.equal(calls[0]?.method, 'DOM.focus');
    assert.equal((calls[1]?.params as { modifiers?: number }).modifiers, 4);
    assert.equal((calls[3]?.params as { key?: string }).key, 'Backspace');
    assert.ok(!calls.some((c) => c.method === 'Input.insertText'));

    calls.length = 0;
    await executeCdpType(
      {
        refs,
        hooks,
        platform: 'linux',
        send: async (method, params) => {
          calls.push({ method, params });
          return {};
        },
      },
      'r1-1',
      'suffix',
      { clear: false },
    );
    assert.deepEqual(
      calls.map((c) => c.method),
      ['DOM.focus', 'Input.insertText'],
    );
  });

  test('supports hover, scroll, pressKey, selectOption, waitFor, screenshot, and dialog formatting', async () => {
    const hooks: CdpExpectedInputHooks = {};
    const refs = new Map<string, BrowserRefTarget>([
      ['r2-1', { id: 21, editable: false, role: 'combobox' }],
    ]);
    const methods: string[] = [];

    await executeCdpHover(
      {
        refs,
        hooks,
        send: async (method) => {
          methods.push(method);
          if (method === 'DOM.getContentQuads') return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
          return {};
        },
      },
      'r2-1',
    );
    assert.ok(methods.includes('Input.dispatchMouseEvent'));

    let wheelDeltaY = 0;
    await executeCdpScroll(
      {
        refs,
        hooks,
        send: async (method, params) => {
          if (method === 'Page.getLayoutMetrics') {
            return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } };
          }
          if (method === 'Input.dispatchMouseEvent') {
            wheelDeltaY = (params as { deltaY?: number }).deltaY ?? 0;
          }
          return {};
        },
      },
      { direction: 'down', amount: 450 },
    );
    assert.equal(wheelDeltaY, 450);

    const pressedKeys: string[] = [];
    await executeCdpPressKey(
      {
        hooks,
        send: async (_method, params) => {
          pressedKeys.push(`${(params as { type: string }).type}:${(params as { key: string }).key}`);
          return {};
        },
      },
      'Escape',
    );
    assert.deepEqual(pressedKeys, ['rawKeyDown:Escape', 'keyUp:Escape']);

    const selected = await executeCdpSelectOption(
      {
        refs,
        send: async (method) => {
          if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
          if (method === 'Runtime.callFunctionOn') {
            return { result: { value: { selectedValue: 'cn', selectedLabel: 'China' } } };
          }
          return {};
        },
      },
      'r2-1',
      { label: 'China' },
    );
    assert.deepEqual(selected, { selectedValue: 'cn', selectedLabel: 'China' });

    let evalCount = 0;
    const waited = await executeCdpWaitFor(
      {
        send: async () => {
          evalCount += 1;
          return { result: { value: evalCount >= 2 ? 'Order confirmed' : 'Loading...' } };
        },
      },
      { text: 'Order confirmed', timeoutMs: 2_000, signal: new AbortController().signal },
    );
    assert.match(waited.text, /已满足/);

    const shot = await executeCdpScreenshot(
      {
        send: async () => ({ data: 'iVBORw0KGgo=' }),
      },
      { fullPage: true },
    );
    assert.equal(shot.png, 'iVBORw0KGgo=');

    const dialog = parseJavascriptDialogOpening({
      type: 'confirm',
      message: 'Delete item?',
      url: 'https://example.test',
    });
    assert.ok(dialog);
    assert.match(formatPendingDialogNotice(dialog, true), /browser_handle_dialog/);
    assert.match(formatPendingDialogNotice(dialog, true), /Delete item\?/);
  });

  test('classifies read-only and input browser tools and validates new tool call schemas', () => {
    assert.equal(isDesktopBrowserReadOnlyTool('browser_scroll'), true);
    assert.equal(isDesktopBrowserReadOnlyTool('browser_hover'), true);
    assert.equal(isDesktopBrowserReadOnlyTool('browser_wait_for'), true);
    assert.equal(isDesktopBrowserReadOnlyTool('browser_handle_dialog'), false);
    assert.equal(isDesktopBrowserInputTool('browser_handle_dialog'), true);
    assert.equal(isDesktopBrowserInputTool('browser_press_key'), true);

    const parsed = desktopBrowserCallSchema.parse({
      type: 'desktop-browser-call',
      protocolVersion: desktopBrowserProtocolVersion,
      id: '00000000-0000-4000-8000-000000000001',
      projectId: '00000000-0000-4000-8000-000000000002',
      runId: '00000000-0000-4000-8000-000000000003',
      name: 'browser_handle_dialog',
      args: { accept: true, promptText: 'ok' },
    });
    assert.equal(parsed.name, 'browser_handle_dialog');
  });

  test('browser_navigate on a fresh tab loads URL without attaching CDP or calling Page.enable first', async () => {
    let attached = false;
    let cdpCalls = 0;
    let loadedUrl = '';
    const wc = {
      getURL: () => loadedUrl,
      getTitle: () => 'Example',
      once: () => {},
      removeListener: () => {},
      loadURL: async (url: string) => {
        loadedUrl = url;
      },
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true;
        },
        on: () => {},
        sendCommand: async () => {
          cdpCalls += 1;
          return {};
        },
      },
    };
    const result = await executeBrowserTool({
      tab: {
        id: 'tab-1',
        owner: {} as never,
        view: {} as never,
        refs: new Map(),
      },
      wc: wc as never,
      request: {
        type: 'desktop-browser-call',
        protocolVersion: desktopBrowserProtocolVersion,
        id: '00000000-0000-4000-8000-000000000001',
        projectId: '00000000-0000-4000-8000-000000000002',
        runId: '00000000-0000-4000-8000-000000000003',
        name: 'browser_navigate',
        args: { url: 'https://example.test/' },
      },
      context: {
        signal: new AbortController().signal,
        waitForNative: (pending) => pending,
        markInputDispatched: () => {},
      },
      siteUrl: (value) => value,
      isVisible: () => true,
      assertOwned: () => {},
      nextRevision: () => 1,
    });

    assert.equal(attached, false);
    assert.equal(cdpCalls, 0);
    assert.match(result.text ?? '', /https:\/\/example\.test\//);
  });

  test('browser_navigate resolves on dom-ready without waiting for stalled loadURL and supports includeSnapshot', async () => {
    const listeners = new Map<string, Set<() => void>>();
    let attached = false;
    let loadedUrl = '';
    const wc = {
      getURL: () => loadedUrl,
      getTitle: () => 'Heavy News Site',
      once: (event: string, fn: () => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(fn);
        listeners.set(event, set);
      },
      removeListener: (event: string, fn: () => void) => {
        listeners.get(event)?.delete(fn);
      },
      loadURL: (url: string) => {
        loadedUrl = url;
        queueMicrotask(() => {
          for (const fn of [...(listeners.get('dom-ready') ?? [])]) fn();
        });
        // Simulate third-party trackers keeping loadURL pending forever.
        return new Promise<void>(() => {});
      },
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true;
        },
        on: () => {},
        sendCommand: async (method: string) => {
          if (method === 'Accessibility.getFullAXTree') {
            return {
              nodes: [
                {
                  nodeId: 'n1',
                  role: { value: 'heading' },
                  name: { value: 'Top Stories' },
                  backendDOMNodeId: 10,
                },
              ],
            };
          }
          if (method === 'Page.getLayoutMetrics') {
            return {
              cssVisualViewport: { pageY: 120, clientWidth: 1280, clientHeight: 720 },
              cssContentSize: { height: 3400 },
            };
          }
          return {};
        },
      },
    };

    const result = await executeBrowserTool({
      tab: {
        id: 'tab-heavy',
        owner: {} as never,
        view: {} as never,
        refs: new Map(),
      },
      wc: wc as never,
      request: {
        type: 'desktop-browser-call',
        protocolVersion: desktopBrowserProtocolVersion,
        id: '00000000-0000-4000-8000-000000000011',
        projectId: '00000000-0000-4000-8000-000000000012',
        runId: '00000000-0000-4000-8000-000000000013',
        name: 'browser_navigate',
        args: { url: 'https://news.example.test/', includeSnapshot: true },
      },
      context: {
        signal: new AbortController().signal,
        waitForNative: (pending) => pending,
        markInputDispatched: () => {},
      },
      siteUrl: (value) => value,
      isVisible: () => true,
      assertOwned: () => {},
      nextRevision: () => 5,
    });

    assert.match(result.text ?? '', /已打开 https:\/\/news\.example\.test\//);
    assert.match(result.text ?? '', /viewport: 1280x720 scroll: 120\/3400/);
    assert.match(result.text ?? '', /- heading "Top Stories" \[ref=r5-1\]/);
  });

  test('executeCdpClick rejects when elementFromPoint reports an occluding overlay and executeCdpFillForm fills mixed fields', async () => {
    const hooks: CdpExpectedInputHooks = {};
    const refs = new Map<string, BrowserRefTarget>([
      ['r4-1', { id: 31, editable: false, role: 'button' }],
      ['r4-2', { id: 32, editable: true, role: 'textbox' }],
      ['r4-3', { id: 33, editable: true, role: 'combobox' }],
    ]);

    await assert.rejects(
      () =>
        executeCdpClick(
          {
            refs,
            hooks,
            send: async (method, params) => {
              if (method === 'DOM.resolveNode') return { object: { objectId: 'btn-obj' } };
              if (method === 'DOM.getContentQuads') return { quads: [[10, 10, 50, 10, 50, 50, 10, 50]] };
              if (method === 'Runtime.callFunctionOn') {
                const fn = (params as { functionDeclaration?: string }).functionDeclaration ?? '';
                if (fn.includes('elementFromPoint')) {
                  return { result: { value: { ok: false, blocker: 'div "Cookie Banner"' } } };
                }
              }
              return {};
            },
          },
          'r4-1',
        ),
      /遮挡（div "Cookie Banner"）/,
    );

    const insertedTexts: string[] = [];
    let selectedCountry = '';
    const filled = await executeCdpFillForm(
      {
        refs,
        hooks,
        send: async (method, params) => {
          if (method === 'Input.insertText') {
            insertedTexts.push((params as { text: string }).text);
          }
          if (method === 'DOM.resolveNode') return { object: { objectId: 'select-obj' } };
          if (method === 'Runtime.callFunctionOn') {
            selectedCountry = 'CN';
            return { result: { value: { selectedValue: 'CN', selectedLabel: 'China' } } };
          }
          return {};
        },
      },
      [
        { ref: 'r4-2', value: 'Alice' },
        { ref: 'r4-3', value: 'China' },
      ],
    );
    assert.equal(filled.filledCount, 2);
    assert.deepEqual(insertedTexts, ['Alice']);
    assert.equal(selectedCountry, 'CN');
  });
});
