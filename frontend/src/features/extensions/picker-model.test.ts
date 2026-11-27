import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SkillInheritanceItem } from '@shared/skill-inheritance';
import type { Draft, Extension } from '@shared/types';
import { uiI18n } from '@/i18n';
import { capabilityLabels, initialConfig } from '@/features/agents/api';
import {
  allowedTools,
  choices,
  chooseDirectory,
  chooseExtension,
  chooseFile,
  completionSkills,
  inCode,
  selectionReason,
  triggerAt,
} from './picker-model';

const base = {
  id: 'skill',
  projectId: 'p1',
  name: 'review',
  description: 'Review changes',
  source: 'manual',
  enabled: true,
  version: 1,
};
const skill: Extension = {
  ...base,
  kind: 'skill',
  body: '# Review',
  supported: true,
  userInvocable: true,
};
const command: Extension = {
  ...base,
  id: 'command',
  kind: 'command',
  body: 'Review $ARGUMENTS',
  supported: true,
  userInvocable: true,
};
const mcp: Extension = {
  ...base,
  id: 'mcp',
  kind: 'mcp',
  name: 'docs',
  transport: { type: 'http', url: 'https://example.com/mcp' },
  status: 'connected',
  tools: [
    { name: 'read', description: 'Read docs' },
    { name: 'write', description: 'Update docs' },
    { name: 'unapproved', description: 'Unapproved' },
  ],
  allowedTools: [
    { name: 'read', access: 'read' },
    { name: 'write', access: 'approval' },
    { name: 'missing', access: 'read' },
  ],
};
const draft: Draft = {
  text: '/rev',
  mode: 'readonly',
  contextPaths: ['src'],
  attachmentIds: ['file'],
};
const atEnd = (text: string) => triggerAt(text, text.length, text.length);

test('only standalone slash/hash tokens activate completion', () => {
  for (const text of ['/', '/rev', 'please /rev', '#docs/read', '#文档.服务/工具', '说明 /代码'])
    assert.ok(atEnd(text), text);
  for (const text of [
    'https://example.com/rev',
    './src/rev',
    '/tmp/file',
    '[/rev](url)',
    '`/rev',
    '\\#docs',
    'prefix/rev',
    '##heading',
  ])
    assert.equal(atEnd(text), null, text);
  assert.equal(triggerAt('/review', 1, 4), null);
  const token = triggerAt('/review trailing', 4, 4)!;
  assert.equal(token.query, 'rev');
  assert.equal(token.word, '/review');
  assert.equal(token.end, 7);
});

test('fenced and inline code remain literal and closing fences restore completion', () => {
  for (const text of ['```ts\n/rev', '~~~\n/rev', '``\n/rev', '    /rev', '\t/rev', '`code /rev'])
    assert.equal(atEnd(text), null, text);
  assert.ok(atEnd('```ts\n`text\n```\n/rev'));
  assert.ok(atEnd('~~~\n`\n~~~\n/rev'));
  assert.ok(atEnd('`code` /rev'));
  assert.equal(inCode('````\n```\n'), true);
  assert.equal(inCode('````\n````\n'), false);
});

test('slash options use authorized preview items while keeping commands at the start only', () => {
  const installed: SkillInheritanceItem = {
    id: skill.id, name: skill.name, description: skill.description, version: 2,
    source: 'atelier', manual: true, auto: false, mode: 'manual', effective: 'manual', override: 'follow',
  };
  const preview = completionSkills([
    installed,
    { ...installed, id: 'workspace', source: 'workspace', mode: 'auto', effective: 'auto' },
    { ...installed, id: 'host', source: 'host', effective: 'off', reason: 'disabled' },
    { ...installed, id: 'auto-only', effective: 'auto', manual: false },
  ]);
  const items = [skill, command, ...preview];
  const text = 'please /rev';
  const token = atEnd(text)!;
  const rows = choices(items, token, text, 'readonly');
  assert.deepEqual(rows.map((row) => [row.item.id, row.skillSource]), [
    ['skill', 'atelier'], ['workspace', 'workspace'],
  ]);
  assert.equal(choices(items, atEnd('/rev')!, '/rev', 'readonly').length, 3);
  assert.deepEqual(choices([skill], token, text, 'readonly'), []);
  const row = rows[0];
  assert.ok(row);
  const selected = chooseExtension({ ...draft, text, extensionSelections: [
    { id: skill.id, version: 1 }, { id: 'workspace', version: 1 },
  ] }, token, row);
  assert.equal(selected.draft.text, 'please ');
  assert.deepEqual(selected.draft.extensionSelections, [
    { id: skill.id, version: 2 }, { id: 'workspace', version: 1 },
  ]);
});

test('MCP completion requires a passing test, discovery, permission and draft-mode access', () => {
  assert.deepEqual(
    allowedTools(mcp, 'readonly').map((tool) => tool.name),
    ['read'],
  );
  assert.deepEqual(
    allowedTools(mcp, 'edit').map((tool) => tool.name),
    ['read', 'write'],
  );
  assert.deepEqual(allowedTools({ ...mcp, status: undefined }, 'edit'), []);
  assert.deepEqual(allowedTools({ ...mcp, status: 'needs-auth' }, 'edit'), []);
  assert.deepEqual(allowedTools({ ...mcp, status: 'failed' }, 'edit'), []);
  assert.deepEqual(allowedTools({ ...mcp, enabled: false }, 'edit'), []);
  assert.deepEqual(
    choices([mcp], atEnd('#')!, '#', 'readonly').map((row) => row.label),
    ['#docs', '#docs/read'],
  );
  assert.deepEqual(
    choices([mcp], atEnd('#')!, '#', 'edit').map((row) => row.label),
    ['#docs', '#docs/read', '#docs/write'],
  );
});

test('command choice inserts its name and leaves draft selections and arguments intact', () => {
  const text = '/rev explain this';
  const input = { ...draft, text, extensionSelections: [{ id: skill.id, version: skill.version }] };
  const token = triggerAt(text, 4, 4)!;
  const result = chooseExtension(input, token, {
    item: command,
    label: '/review',
    description: '',
    kind: 'Commands',
  });
  assert.equal(result.draft.text, '/review  explain this');
  assert.equal(result.caret, 8);
  assert.deepEqual(result.draft.extensionSelections, input.extensionSelections);
  assert.equal(input.text, text);
});

test('skill selection removes the whole token and preserves context, attachments and mode', () => {
  const input = { ...draft, text: 'please /review now' };
  const token = triggerAt(input.text, 10, 10)!;
  const result = chooseExtension(input, token, {
    item: skill,
    label: '/review',
    description: '',
    kind: 'Skills',
  });
  assert.equal(result.draft.text, 'please  now');
  assert.deepEqual(result.draft.extensionSelections, [{ id: skill.id, version: skill.version }]);
  assert.deepEqual(result.draft.contextPaths, ['src']);
  assert.deepEqual(result.draft.attachmentIds, ['file']);
  assert.equal(result.draft.mode, 'readonly');
  assert.equal(input.extensionSelections, undefined);
});

test('MCP choices union permitted tools at the same version and replace stale selections', () => {
  const input: Draft = {
    ...draft,
    text: '#docs/write',
    mode: 'edit',
    extensionSelections: [{ id: mcp.id, version: mcp.version, tools: ['read', 'missing'] }],
  };
  const row = { item: mcp, label: '#docs/write', description: '', kind: 'MCP', tools: ['write'] };
  assert.deepEqual(
    chooseExtension(input, atEnd(input.text)!, row).draft.extensionSelections?.[0]?.tools,
    ['read', 'write'],
  );
  assert.deepEqual(
    chooseExtension(
      { ...input, extensionSelections: [{ id: mcp.id, version: 0, tools: ['read'] }] },
      atEnd(input.text)!,
      row,
    ).draft.extensionSelections?.[0]?.tools,
    ['write'],
  );
  assert.deepEqual(
    chooseExtension(
      { ...input, extensionSelections: [{ id: mcp.id, version: 1, tools: ['write'] }] },
      atEnd(input.text)!,
      row,
    ).draft.extensionSelections?.[0]?.tools,
    ['write'],
  );
});

test('completion labels follow language changes while selections and template instructions stay as data', async () => {
  const template = initialConfig(true);
  const selection = { id: skill.id, version: 1 };
  try {
    await uiI18n.changeLanguage('en');
    assert.equal(capabilityLabels.read.label, 'Read files');
    assert.equal(selectionReason(undefined, selection, 'readonly', true), 'Unavailable');
    const readRows = choices([mcp], atEnd('#')!, '#', 'readonly');
    const editRows = choices([mcp], atEnd('#')!, '#', 'edit');
    assert.equal(readRows[0]?.description, '1 allowed tool');
    assert.equal(editRows[0]?.description, '2 allowed tools');
    assert.equal(readRows[1]?.description, 'Read docs');
    const token = atEnd('#docs');
    const choice = readRows[0];
    assert.ok(token);
    assert.ok(choice);
    assert.deepEqual(
      chooseExtension({ ...draft, text: '#docs' }, token, choice).draft.extensionSelections,
      [{ id: mcp.id, version: mcp.version, tools: ['read'] }],
    );
    assert.deepEqual(initialConfig(true), template);
    await uiI18n.changeLanguage('zh-CN');
    assert.equal(capabilityLabels.read.label, '读取文件');
    assert.equal(choices([mcp], atEnd('#')!, '#', 'readonly')[0]?.description, '1 个已允许的工具');
  } finally {
    await uiI18n.changeLanguage('zh-CN');
  }
});

test('chips report missing, disabled, incompatible, changed and restricted tools', () => {
  const selection = { id: skill.id, version: 1 };
  assert.equal(selectionReason(undefined, selection, 'readonly', false), '');
  assert.equal(selectionReason(undefined, selection, 'readonly', true), '已不可用');
  assert.equal(
    selectionReason({ ...skill, enabled: false }, selection, 'readonly', true),
    '已停用',
  );
  assert.equal(
    selectionReason({ ...skill, supported: false }, selection, 'readonly', true),
    '暂不兼容',
  );
  assert.equal(
    selectionReason({ ...skill, version: 2 }, selection, 'readonly', true),
    '版本已变化，请重新选择',
  );
  assert.equal(
    selectionReason(mcp, { id: mcp.id, version: 1, tools: ['write'] }, 'readonly', true),
    '请测试连接或重新选择工具',
  );
  assert.equal(
    selectionReason(mcp, { id: mcp.id, version: 1, tools: ['read'] }, 'readonly', true),
    '',
  );
});

test('@ token activates file completion and excludes emails', () => {
  for (const text of ['@', '@styles', 'please @frontend/src/styles.css', '说明 @代码']) {
    const token = atEnd(text);
    assert.ok(token, text);
    assert.equal(token.symbol, '@');
  }
  for (const text of ['user@example.com', 'test@domain.org', '`@styles`', '```\n@styles\n```']) {
    assert.equal(atEnd(text), null, text);
  }
});

test('chooseFile updates draft text with @file reference and does not modify contextPaths', () => {
  const inputDraft: Draft = {
    text: 'please check @styl and fix it',
    mode: 'edit',
    contextPaths: ['src/existing.ts'],
    attachmentIds: [],
  };
  const token = triggerAt('please check @styl', 18, 18)!;
  assert.equal(token.symbol, '@');
  assert.equal(token.query, 'styl');

  const result = chooseFile(inputDraft, token, {
    path: 'frontend/src/styles.css',
    name: 'styles.css',
  });
  assert.equal(result.draft.text, 'please check @frontend/src/styles.css  and fix it');
  assert.deepEqual(result.draft.contextPaths, ['src/existing.ts']);
  assert.equal(result.caret, 'please check @frontend/src/styles.css '.length);
});

test('chooseDirectory replaces @query with @dir/ without trailing space and does not modify contextPaths', () => {
  const inputDraft: Draft = {
    text: 'please inspect @front and review',
    mode: 'edit',
    contextPaths: ['src/existing.ts'],
    attachmentIds: [],
  };
  const token = triggerAt('please inspect @front', 21, 21)!;
  assert.equal(token.symbol, '@');
  assert.equal(token.query, 'front');

  const result = chooseDirectory(inputDraft, token, {
    path: 'frontend',
  });
  assert.equal(result.draft.text, 'please inspect @frontend/ and review');
  assert.deepEqual(result.draft.contextPaths, ['src/existing.ts']);
  assert.equal(result.caret, 'please inspect @frontend/'.length);

  // Triggering next-level directory completion
  const nextToken = triggerAt(result.draft.text, result.caret, result.caret)!;
  assert.equal(nextToken.symbol, '@');
  assert.equal(nextToken.query, 'frontend/');

  // Continuing to next-level subfolder
  const subResult = chooseDirectory(result.draft, nextToken, {
    path: 'frontend/src',
  });
  assert.equal(subResult.draft.text, 'please inspect @frontend/src/ and review');
  assert.deepEqual(subResult.draft.contextPaths, ['src/existing.ts']);
  assert.equal(subResult.caret, 'please inspect @frontend/src/'.length);

  // Finally choosing a file in the nested directory
  const fileToken = triggerAt(subResult.draft.text, subResult.caret, subResult.caret)!;
  assert.equal(fileToken.symbol, '@');
  assert.equal(fileToken.query, 'frontend/src/');

  const finalResult = chooseFile(subResult.draft, fileToken, {
    path: 'frontend/src/styles.css',
    name: 'styles.css',
  });
  assert.equal(finalResult.draft.text, 'please inspect @frontend/src/styles.css  and review');
  assert.deepEqual(finalResult.draft.contextPaths, ['src/existing.ts']);
  assert.equal(finalResult.caret, 'please inspect @frontend/src/styles.css '.length);
});
