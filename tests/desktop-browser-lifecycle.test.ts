/**
 * @file 验证原生浏览器操作生命周期管理与 CDP 无障碍/输入驱动。
 * @implementation 覆盖只读取消、交互超时替身、输入已派发警告前缀、崩溃标签恢复以及 withExpectedKey/Mouse 在异常退出时的钩子清理。
 * @updated 2026-11-27T22:00:00+08:00
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  executeCdpClick,
  executeCdpType,
  snapshotAccessibilityTree,
  type CdpExpectedInputHooks,
} from '../desktop/browser/cdp-driver.mjs';
import {
  runBrowserOperation,
  type BrowserOperationHandle,
} from '../desktop/browser/operation-lifecycle.mjs';
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
  test('orders interactive accessibility nodes ahead of static text and tracks editable refs', async () => {
    const refs = new Map<string, { id: number; editable: boolean }>();
    const result = await snapshotAccessibilityTree({
      revision: 3,
      url: 'https://example.test/form',
      title: 'Form',
      refs,
      send: async () => ({
        nodes: [
          {
            ignored: false,
            backendDOMNodeId: 10,
            role: { value: 'StaticText' },
            name: { value: 'Intro' },
          },
          {
            ignored: true,
            backendDOMNodeId: 11,
            role: { value: 'button' },
            name: { value: 'Hidden' },
          },
          { ignored: false, backendDOMNodeId: 12, role: { value: 'textbox' } },
          {
            ignored: false,
            backendDOMNodeId: 13,
            role: { value: 'button' },
            name: { value: 'Save' },
          },
        ],
      }),
    });

    const parsed = JSON.parse(result.text) as {
      url: string;
      title: string;
      elements: Array<{ ref?: string; role: string; name: string }>;
    };
    assert.equal(parsed.url, 'https://example.test/form');
    assert.deepEqual(
      parsed.elements.map((item) => item.role),
      ['textbox', 'button', 'StaticText'],
    );
    assert.deepEqual(refs.get('r3-1'), { id: 12, editable: true });
    assert.deepEqual(refs.get('r3-2'), { id: 13, editable: false });
    assert.deepEqual(refs.get('r3-3'), { id: 10, editable: false });
  });

  test('always clears expectedKey and expectedMouse hooks when CDP send fails', async () => {
    const hooks: CdpExpectedInputHooks = {};
    const refs = new Map([
      ['r1-1', { id: 42, editable: true }],
      ['r1-2', { id: 99, editable: false }],
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
              if (method === 'DOM.getBoxModel') {
                return { model: { content: [10, 10, 30, 10, 30, 30, 10, 30] } };
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
});
