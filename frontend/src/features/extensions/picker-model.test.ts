import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Draft, Extension } from '@shared/types';
import {
  allowedTools,
  choices,
  chooseExtension,
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

test('commands appear only at the start while manual skills can be selected inline', () => {
  const text = 'please /rev';
  const token = atEnd(text)!;
  assert.deepEqual(
    choices([skill, command], token, text, 'readonly').map((row) => row.item.id),
    ['skill'],
  );
  assert.equal(choices([skill, command], atEnd('/rev')!, '/rev', 'readonly').length, 2);
  assert.deepEqual(
    choices(
      [
        { ...skill, enabled: false },
        { ...skill, supported: false },
        { ...skill, userInvocable: false },
      ],
      atEnd('/')!,
      '/',
      'readonly',
    ),
    [],
  );
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
