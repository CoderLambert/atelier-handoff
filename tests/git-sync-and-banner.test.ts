/**
 * @file 测试 Git 智能远端同步按钮文案计算与异常状态横幅逻辑。
 * @implementation 验证基于 upstream/ahead/behind 的按钮动态状态及 NORMAL/MERGING/DETACHED 状态横幅条件渲染。
 * @updated 2026-11-25T03:33:00+08:00
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { GitRepoStatus } from '../shared/desktop-git.js';

function computeSyncButtonState(status?: GitRepoStatus | null) {
  const upstream = status?.upstream;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;

  if (!upstream) {
    return { action: 'publish', label: '发布分支' };
  }
  if (ahead > 0 && behind > 0) {
    return { action: 'sync', label: `同步 ↓${behind} ↑${ahead}` };
  }
  if (behind > 0) {
    return { action: 'pull', label: `拉取 ↓${behind}` };
  }
  if (ahead > 0) {
    return { action: 'push', label: `推送 ↑${ahead}` };
  }
  return { action: 'fetch', label: '获取' };
}

function computeBannerVisibility(status?: GitRepoStatus | null) {
  const repoState = status?.repoState ?? 'NORMAL';
  if (repoState === 'NORMAL') {
    return { visible: false, type: null, conflictCount: 0 };
  }
  return {
    visible: true,
    type: repoState,
    conflictCount: status?.conflictFiles?.length ?? 0,
  };
}

describe('Git 智能远端同步与异常状态横幅', () => {
  test('智能远端同步主按钮文案与操作判定', () => {
    // 1. 无 upstream
    const s1 = computeSyncButtonState({
      currentBranch: 'feature/new',
      upstream: null,
      ahead: 0,
      behind: 0,
      isDirty: false,
      repoState: 'NORMAL',
      conflictFiles: [],
    });
    assert.equal(s1.action, 'publish');
    assert.equal(s1.label, '发布分支');

    // 2. 仅 behind > 0
    const s2 = computeSyncButtonState({
      currentBranch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 3,
      isDirty: false,
      repoState: 'NORMAL',
      conflictFiles: [],
    });
    assert.equal(s2.action, 'pull');
    assert.equal(s2.label, '拉取 ↓3');

    // 3. 仅 ahead > 0
    const s3 = computeSyncButtonState({
      currentBranch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 0,
      isDirty: false,
      repoState: 'NORMAL',
      conflictFiles: [],
    });
    assert.equal(s3.action, 'push');
    assert.equal(s3.label, '推送 ↑2');

    // 4. 双向更新: ahead > 0 && behind > 0
    const s4 = computeSyncButtonState({
      currentBranch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 5,
      isDirty: false,
      repoState: 'NORMAL',
      conflictFiles: [],
    });
    assert.equal(s4.action, 'sync');
    assert.equal(s4.label, '同步 ↓5 ↑2');

    // 5. 均为 0
    const s5 = computeSyncButtonState({
      currentBranch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      isDirty: false,
      repoState: 'NORMAL',
      conflictFiles: [],
    });
    assert.equal(s5.action, 'fetch');
    assert.equal(s5.label, '获取');
  });

  test('仓库异常状态横幅条件渲染与冲突计数', () => {
    // 1. NORMAL 状态横幅完全隐藏
    const b1 = computeBannerVisibility({
      currentBranch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      isDirty: false,
      repoState: 'NORMAL',
      conflictFiles: [],
    });
    assert.equal(b1.visible, false);

    // 2. MERGING 状态展示冲突文件数
    const b2 = computeBannerVisibility({
      currentBranch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      isDirty: true,
      repoState: 'MERGING',
      conflictFiles: ['src/app.ts', 'package.json'],
    });
    assert.equal(b2.visible, true);
    assert.equal(b2.type, 'MERGING');
    assert.equal(b2.conflictCount, 2);

    // 3. REBASING 状态
    const b3 = computeBannerVisibility({
      currentBranch: 'feature/test',
      upstream: 'origin/feature/test',
      ahead: 1,
      behind: 1,
      isDirty: true,
      repoState: 'REBASING',
      conflictFiles: ['README.md'],
    });
    assert.equal(b3.visible, true);
    assert.equal(b3.type, 'REBASING');
    assert.equal(b3.conflictCount, 1);

    // 4. CHERRY_PICKING 状态
    const b4 = computeBannerVisibility({
      currentBranch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      isDirty: true,
      repoState: 'CHERRY_PICKING',
      conflictFiles: ['src/index.ts'],
    });
    assert.equal(b4.visible, true);
    assert.equal(b4.type, 'CHERRY_PICKING');
    assert.equal(b4.conflictCount, 1);

    // 5. DETACHED 状态
    const b5 = computeBannerVisibility({
      currentBranch: 'e3f1a2b',
      upstream: null,
      ahead: 0,
      behind: 0,
      isDirty: false,
      repoState: 'DETACHED',
      conflictFiles: [],
    });
    assert.equal(b5.visible, true);
    assert.equal(b5.type, 'DETACHED');
    assert.equal(b5.conflictCount, 0);
  });
});
