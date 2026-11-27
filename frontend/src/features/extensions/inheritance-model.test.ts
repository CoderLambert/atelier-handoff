/**
 * @file 验证会话 Skill 草稿选择与继承查询规则。
 * @implementation 使用合成数据检查可选性、数量上限、失效版本、选择合并及范围地址。
 * @updated 2026-11-26T00:06:59+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SkillInheritanceItem } from '@shared/skill-inheritance';
import type { Draft } from '@shared/types';
import { skillInheritanceEndpoint, skillInheritanceKeys } from '@/use-query/skill-inheritance/keys';
import {
  addDraftSkill,
  canRestrictSkill,
  draftSelectionLimit,
  isCurrentSkillSelection,
  recordedOnRun,
  removeDraftSkill,
} from './inheritance-model';

const host: SkillInheritanceItem = {
  id: '90000000-0000-4000-8000-000000000001',
  name: 'fixture-skill',
  description: 'Synthetic Skill',
  source: 'host',
  version: 2,
  mode: 'auto',
  effective: 'auto',
  override: 'follow',
  manual: true,
  auto: true,
};
const installed: SkillInheritanceItem = {
  ...host,
  id: '90000000-0000-4000-8000-000000000002',
  source: 'atelier',
};
const draft: Draft = {
  text: 'Keep this text intact',
  mode: 'readonly',
  contextPaths: ['sample.md'],
  attachmentIds: [],
  extensionSelections: [{ id: 'fixture-mcp', version: 1, tools: ['read'] }],
};

test('only manual-capable and effectively enabled skills can be selected, without modifying draft content', () => {
  for (const unavailable of [
    { ...host, effective: 'off', reason: 'global-off' },
    { ...host, effective: 'off', reason: 'project-blocked' },
    { ...host, effective: 'off', reason: 'not-native' },
    { ...host, effective: 'off', reason: 'session-off' },
  ] as const) {
    assert.equal(addDraftSkill(draft, unavailable), draft);
  }
  assert.equal(addDraftSkill(draft, { ...host, manual: false }), draft);
  const selected = addDraftSkill(addDraftSkill(draft, host), installed);
  assert.deepEqual(selected, {
    ...draft,
    extensionSelections: [
      ...(draft.extensionSelections ?? []),
      { id: host.id, version: host.version },
      { id: installed.id, version: installed.version },
    ],
  });
  assert.equal(addDraftSkill(selected, host), selected);
  assert.deepEqual(removeDraftSkill(removeDraftSkill(selected, host.id), installed.id), draft);
  const full = {
    ...draft,
    extensionSelections: Array.from({ length: draftSelectionLimit }, (_, i) => ({
      id: `${i}`,
      version: 1,
    })),
  };
  assert.equal(addDraftSkill(full, host), full);
});

test('stale draft selections are not updated implicitly by the session dialog', () => {
  const selection = { id: host.id, version: host.version };
  const selected = addDraftSkill(draft, host);
  assert.equal(isCurrentSkillSelection(selection, host), true);
  assert.equal(isCurrentSkillSelection(selection, { ...host, effective: 'off' }), false);
  assert.equal(isCurrentSkillSelection(selection, { ...host, manual: false }), false);
  assert.equal(isCurrentSkillSelection(selection, { ...host, version: host.version + 1 }), false);
  assert.equal(addDraftSkill(selected, { ...host, version: host.version + 1 }), selected);
});

test('a session can undo its own restriction, but cannot override a disabled parent', () => {
  assert.equal(canRestrictSkill(host), true);
  assert.equal(
    canRestrictSkill({ ...host, effective: 'off', override: 'off', reason: 'session-off' }),
    true,
  );
  assert.equal(
    canRestrictSkill({ ...host, effective: 'off', override: 'off', reason: 'project-blocked' }),
    false,
  );
  const receipt = [{ id: host.id, version: host.version, kind: 'skill', name: host.name }] as const;
  assert.equal(recordedOnRun(host, [...receipt]), true);
  assert.equal(recordedOnRun(installed, [...receipt]), false);
  assert.equal(recordedOnRun({ ...host, version: host.version + 1 }, [...receipt]), false);
});

test('GET and PATCH use distinct session preview modes, with automatic and native mutually exclusive', () => {
  const global = { type: 'global' } as const;
  const project = { type: 'project', projectId: 'project / one' } as const;
  const controlled = {
    type: 'session',
    projectId: 'p',
    sessionId: 'session & one',
    mode: 'controlled',
  } as const;
  const native = { ...controlled, mode: 'native' } as const;
  const automatic = { ...controlled, mode: 'automatic' } as const;
  assert.equal(skillInheritanceEndpoint(global), '/api/skill-inheritance');
  assert.equal(
    skillInheritanceEndpoint(project),
    '/api/skill-inheritance?projectId=project+%2F+one',
  );
  assert.equal(
    skillInheritanceEndpoint(controlled),
    '/api/skill-inheritance?sessionId=session+%26+one',
  );
  assert.equal(
    skillInheritanceEndpoint(native),
    '/api/skill-inheritance?sessionId=session+%26+one&native=1',
  );
  assert.equal(
    skillInheritanceEndpoint(automatic),
    '/api/skill-inheritance?sessionId=session+%26+one&automatic=1',
  );
  const keys = [controlled, native, automatic].map((scope) =>
    JSON.stringify(skillInheritanceKeys.view(scope)),
  );
  assert.equal(new Set(keys).size, 3);
  assert.notDeepEqual(
    skillInheritanceKeys.view({ ...native, sessionId: 'other' }),
    skillInheritanceKeys.view(native),
  );
});
