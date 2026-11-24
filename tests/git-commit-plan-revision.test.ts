/**
 * @file 验证提交草稿的对话增量操作。
 * @implementation 校验同目录批量改动的归组、保留其他编辑以及未知或受限 ID 原子拒绝。
 * @updated 2026-11-25T01:12:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCommitRevision } from '../server/modules/git/commit-plan-revision.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const wiki = Array.from({ length: 25 }, (_, index) => `openwiki-${index}`);
const base = {
  groups: [
    { id: first, title: 'Runtime', body: 'User-written body', unitIds: ['runtime'] },
    { id: second, title: 'Styles', body: 'Another change', unitIds: ['style'] },
  ],
  excludedUnitIds: ['protected'],
};
const eligible = new Set(['runtime', 'style', ...wiki]);
const request = {
  note: '',
  edits: [
    { kind: 'new', title: 'Update OpenWiki', body: '', unitIds: wiki },
    { kind: 'message', groupId: first, title: 'Improve the Git workflow' },
  ],
};

test('a single turn groups 25 remaining units and changes only the requested commit subject', () => {
  const next = applyCommitRevision(base, eligible, request);
  assert.deepEqual(next.groups[0], { ...base.groups[0], title: 'Improve the Git workflow' });
  assert.deepEqual(next.groups[1], base.groups[1]);
  assert.deepEqual(next.groups[2]?.unitIds, wiki);
  assert.deepEqual(next.excludedUnitIds, ['protected']);
  assert.equal(base.groups.length, 2);
  const revised = applyCommitRevision(next, eligible, {
    note: '',
    edits: [{ kind: 'move', groupId: second, unitIds: wiki }],
  });
  assert.equal(revised.groups.length, 2);
  assert.deepEqual(revised.groups[1]?.unitIds, ['style', ...wiki]);
});

test('unknown, protected, duplicate and command operations reject the entire turn', () => {
  for (const last of [
    { kind: 'keep', unitIds: ['protected'] },
    { kind: 'keep', unitIds: [wiki[0]] },
    { kind: 'message', groupId: '33333333-3333-4333-8333-333333333333', title: 'Unknown' },
    { kind: 'execute', command: 'git status' },
    { kind: 'message', groupId: first, title: ['ghp', '012345678901234567890'].join('_') },
  ]) {
    assert.throws(
      () =>
        applyCommitRevision(base, eligible, {
          ...request,
          edits: [...request.edits, last],
        }),
      { code: 'GIT_PLAN_REVISION_INVALID' },
    );
    assert.equal(base.groups[0]?.title, 'Runtime');
    assert.equal(base.groups.length, 2);
  }
});
