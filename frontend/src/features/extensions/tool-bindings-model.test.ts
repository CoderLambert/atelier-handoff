import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Extension, SkillToolBinding } from '@shared/types';
import { mcpBindingIssue, newBinding, validateBindings } from './tool-bindings-model';

const mcp: Extract<Extension, { kind: 'mcp' }> = {
  id: 'docs',
  projectId: 'project',
  name: 'docs',
  description: '',
  source: 'manual',
  enabled: true,
  version: 1,
  kind: 'mcp',
  transport: { type: 'http', url: 'https://example.com/mcp' },
  status: 'connected',
  tools: [
    { name: 'read', description: 'Read docs' },
    { name: 'write', description: 'Write docs' },
    { name: 'not_granted', description: '' },
  ],
  allowedTools: [
    { name: 'read', access: 'read' },
    { name: 'write', access: 'approval' },
    { name: 'not_discovered', access: 'read' },
  ],
};
const http: Extract<SkillToolBinding, { kind: 'http' }> = {
  name: 'weather',
  kind: 'http',
  url: 'https://wttr.in/{location}?format=j1',
  parameter: 'location',
  description: '城市名称',
};

test('binding names are unique bounded lowercase identifiers and lists can be cleared', () => {
  assert.deepEqual(validateBindings([], []), []);
  assert.deepEqual(validateBindings([newBinding('builtin', ' list_files ')], []), [
    { name: 'list_files', kind: 'builtin', tool: 'list_files' },
  ]);
  for (const name of ['', '_files', 'ListFiles', 'a-b', '1files', 'a'.repeat(33)])
    assert.throws(() => validateBindings([newBinding('builtin', name)], []), /名称/);
  assert.throws(
    () => validateBindings([newBinding('builtin', 'same'), newBinding('command', 'same')], []),
    /名称 same 重复/,
  );
  assert.throws(
    () =>
      validateBindings(
        Array.from({ length: 11 }, (_, i) => newBinding('builtin', `tool_${i}`)),
        [],
      ),
    /最多绑定 10/,
  );
});

test('changing binding kinds discards fields belonging to the previous source', () => {
  assert.deepEqual(newBinding('command', http.name), {
    name: 'weather',
    kind: 'command',
    preset: 'pdftotext',
  });
  assert.deepEqual(newBinding('mcp', http.name), {
    name: 'weather',
    kind: 'mcp',
    extensionId: '',
    tool: '',
  });
});

test('HTTPS bindings support query keys and matching whole path segment placeholders', () => {
  assert.deepEqual(validateBindings([http], []), [http]);
  assert.equal(
    validateBindings([{ ...http, url: 'https://example.com/search', parameter: 'query' }], [])
      .length,
    1,
  );
  assert.equal(
    validateBindings([{ ...http, url: 'https://example.com/{city}', parameter: 'city' }], [])
      .length,
    1,
  );
  for (const url of [
    'https://example.com/{other}',
    'https://example.com/prefix{location}',
    'https://example.com/?q={location}',
    'https://{location}.example.com/',
    'https://example.com/{location}/{location}',
    'https://example.com/{location',
  ])
    assert.throws(() => validateBindings([{ ...http, url }], []), /占位符/);
});

test('HTTPS validation rejects unsafe URL shapes and empty or oversized input descriptions', () => {
  for (const url of [
    'http://example.com/',
    'file:///tmp/test',
    'https://user:password@example.com/',
    'https://example.com:8443/',
    'https://example.com/#fragment',
    'https://localhost/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://service.local/',
    'https://example.com/' + 'x'.repeat(1000),
  ])
    assert.throws(() => validateBindings([{ ...http, url }], []), /URL/);
  for (const description of ['', '   ', 'x'.repeat(301)])
    assert.throws(() => validateBindings([{ ...http, description }], []), /输入描述/);
  assert.throws(() => validateBindings([{ ...http, parameter: 'Query' }], []), /参数名/);
});

test('MCP binding targets need a connected enabled service, discovery and a project grant', () => {
  const binding: Extract<SkillToolBinding, { kind: 'mcp' }> = {
    name: 'read_docs',
    kind: 'mcp',
    extensionId: 'docs',
    tool: 'read',
  };
  assert.equal(mcpBindingIssue(binding, [mcp]), '');
  assert.deepEqual(
    validateBindings([binding, { ...binding, name: 'write_docs', tool: 'write' }], [mcp]).length,
    2,
  );
  assert.match(mcpBindingIssue(binding, []), /未安装或已移除/);
  assert.match(mcpBindingIssue(binding, [{ ...mcp, enabled: false }]), /已停用/);
  assert.match(mcpBindingIssue(binding, [{ ...mcp, status: 'failed' }]), /尚未连接/);
  assert.match(mcpBindingIssue({ ...binding, tool: 'not_granted' }, [mcp]), /尚未允许/);
  assert.match(mcpBindingIssue({ ...binding, tool: 'not_discovered' }, [mcp]), /不在发现结果/);
  assert.throws(() => validateBindings([{ ...binding, tool: '' }], [mcp]), /请选择/);
  assert.throws(() => validateBindings([binding], []), /第 1 个绑定/);
});
