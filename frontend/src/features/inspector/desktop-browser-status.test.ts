/**
 * @file 验证桌面浏览器状态推导与原生槽位坐标去重边界。
 * @implementation 覆盖 deriveDesktopBrowserStatus 的全部错误/交接/授权/标签分支与 tone 映射，并核对 boundsEqual 几何坐标去重。
 * @updated 2026-11-27T22:00:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveDesktopBrowserStatus,
  type DeriveDesktopBrowserStatusInput,
} from '@/app/desktop-browser-status';
import { boundsEqual } from '@/app/use-native-browser-slot';
import type { DesktopBrowserState } from '@shared/desktop-browser';

function sampleState(overrides: Partial<DesktopBrowserState> = {}): DesktopBrowserState {
  return {
    projectId: 'proj-1',
    tabs: [{ id: 'tab-1', title: 'Example', url: 'https://example.test' }],
    activeTabId: 'tab-1',
    agentTabId: 'tab-1',
    transferring: false,
    url: 'https://example.test',
    title: 'Example',
    control: false,
    busy: false,
    downloads: [],
    downloadDirectory: '/tmp/downloads',
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<DeriveDesktopBrowserStatusInput> = {},
): DeriveDesktopBrowserStatusInput {
  return {
    state: sampleState(),
    hasError: false,
    transferring: false,
    accessPending: false,
    agentAvailable: true,
    agentEnabled: true,
    hasAgentTab: true,
    differentAgentTab: false,
    ...overrides,
  };
}

test('boundsEqual distinguishes null, identical, and differing slot coordinates', () => {
  assert.equal(boundsEqual(undefined, null), false);
  assert.equal(boundsEqual(null, null), true);
  assert.equal(boundsEqual(null, { x: 10, y: 20, width: 300, height: 400 }), false);
  assert.equal(
    boundsEqual(
      { x: 10, y: 20, width: 300, height: 400 },
      { x: 10, y: 20, width: 300, height: 400 },
    ),
    true,
  );
  assert.equal(
    boundsEqual(
      { x: 10, y: 20, width: 300, height: 400 },
      { x: 10, y: 20, width: 301, height: 400 },
    ),
    false,
  );
});

test('deriveDesktopBrowserStatus resolves priority order and tones accurately across all branches', () => {
  assert.deepEqual(deriveDesktopBrowserStatus(baseInput({ hasError: true, transferring: true })), {
    tone: 'error',
    key: null,
    showAgentTarget: false,
  });

  assert.deepEqual(
    deriveDesktopBrowserStatus(baseInput({ transferring: true, differentAgentTab: true })),
    { tone: 'busy', key: 'status.transferring', showAgentTarget: false },
  );

  assert.deepEqual(deriveDesktopBrowserStatus(baseInput({ state: undefined })), {
    tone: 'idle',
    key: 'status.connecting',
    showAgentTarget: false,
  });

  assert.deepEqual(
    deriveDesktopBrowserStatus(
      baseInput({ state: sampleState({ control: true, busy: true }), differentAgentTab: true }),
    ),
    { tone: 'control', key: 'status.paused', showAgentTarget: false },
  );

  assert.deepEqual(deriveDesktopBrowserStatus(baseInput({ accessPending: true })), {
    tone: 'idle',
    key: 'status.readingAccess',
    showAgentTarget: false,
  });

  assert.deepEqual(deriveDesktopBrowserStatus(baseInput({ agentAvailable: false })), {
    tone: 'notice',
    key: 'status.unavailable',
    showAgentTarget: false,
  });

  assert.deepEqual(deriveDesktopBrowserStatus(baseInput({ agentEnabled: false })), {
    tone: 'notice',
    key: 'status.disabled',
    showAgentTarget: false,
  });

  assert.deepEqual(
    deriveDesktopBrowserStatus(baseInput({ state: sampleState({ tabs: [] }), hasAgentTab: false })),
    { tone: 'idle', key: 'status.noTabs', showAgentTarget: false },
  );

  assert.deepEqual(deriveDesktopBrowserStatus(baseInput({ differentAgentTab: true })), {
    tone: 'notice',
    key: 'status.otherTab',
    showAgentTarget: true,
  });

  assert.deepEqual(deriveDesktopBrowserStatus(baseInput({ state: sampleState({ busy: true }) })), {
    tone: 'busy',
    key: 'status.busy',
    showAgentTarget: false,
  });

  assert.deepEqual(deriveDesktopBrowserStatus(baseInput({ hasAgentTab: true })), {
    tone: 'idle',
    key: 'status.agentTab',
    showAgentTarget: false,
  });

  assert.deepEqual(deriveDesktopBrowserStatus(baseInput({ hasAgentTab: false })), {
    tone: 'idle',
    key: 'status.waiting',
    showAgentTarget: false,
  });
});
