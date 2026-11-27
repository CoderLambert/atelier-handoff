/**
 * @file 验证共享类型拆桶边界、前后端统一扩展校验契约和结构化诊断分类。
 * @implementation 检查 errors 零依赖、types 兼容重导出、Zod 校验错误码与边界常量，以及静态与参数化诊断文本分类。
 * @updated 2026-11-27T21:30:00+08:00
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AppError, now } from '../shared/errors.js';
import {
  EXTENSION_BODY_MAX,
  EXTENSION_DESCRIPTION_MAX,
  EXTENSION_NAME_MAX,
  checkMcpHttpUrl,
  classifyExtensionDiagnostic,
  extensionDiagnosticMessages,
  extensionInputSchema,
  isAbsoluteExecutablePath,
  validateExtensionInput,
} from '../shared/extensions.js';
import * as compatTypes from '../shared/types.js';

test('shared/errors has zero imports and shared/types retains compatibility re-exports', async () => {
  const source = await readFile(new URL('../shared/errors.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\b/u);
  const error = new AppError('ERR_CODE', 'message', 409, true);
  assert.equal(error.code, 'ERR_CODE');
  assert.equal(error.status, 409);
  assert.equal(error.retryable, true);
  assert.match(now(), /^\d{4}-\d{2}-\d{2}T/u);

  assert.equal(compatTypes.AppError, AppError);
  assert.equal(compatTypes.now, now);
  assert.ok(compatTypes.gatewayModelCatalogSchema);
  assert.ok(compatTypes.extensionInputSchema);
  assert.ok(compatTypes.agentCapabilities.includes('read'));
});

test('validateExtensionInput enforces unified name, description, env, URL, and command rules', () => {
  const validSkill = validateExtensionInput({
    kind: 'skill',
    name: 'my_skill-1',
    description: 'Short summary',
    enabled: true,
    body: '# Heading',
  });
  assert.equal(validSkill.ok, true);
  assert.deepEqual(
    extensionInputSchema.parse({
      kind: 'skill',
      name: 'my_skill-1',
      description: 'Short summary',
      enabled: true,
      body: '# Heading',
    }),
    validSkill.ok ? validSkill.data : null,
  );

  for (const badName of [
    'Uppercase',
    'bad:name',
    'bad.name',
    '-leading',
    'a'.repeat(EXTENSION_NAME_MAX + 1),
  ]) {
    const res = validateExtensionInput({
      kind: 'command',
      name: badName,
      description: '',
      enabled: true,
      body: 'hello',
    });
    assert.equal(res.ok, false, badName);
    if (!res.ok) assert.equal(res.code, 'invalid_name');
  }

  const longDescription = validateExtensionInput({
    kind: 'command',
    name: 'valid-cmd',
    description: 'x'.repeat(EXTENSION_DESCRIPTION_MAX + 1),
    enabled: true,
    body: 'hello',
  });
  assert.equal(longDescription.ok, false);
  if (!longDescription.ok) assert.equal(longDescription.code, 'description_too_long');

  const emptyBody = validateExtensionInput({
    kind: 'skill',
    name: 'valid-skill',
    description: '',
    enabled: true,
    body: '',
  });
  assert.equal(emptyBody.ok, false);
  if (!emptyBody.ok) assert.equal(emptyBody.code, 'body_required');

  const longBody = validateExtensionInput({
    kind: 'skill',
    name: 'valid-skill',
    description: '',
    enabled: true,
    body: 'x'.repeat(EXTENSION_BODY_MAX + 1),
  });
  assert.equal(longBody.ok, false);
  if (!longBody.ok) assert.equal(longBody.code, 'body_too_long');

  assert.equal(checkMcpHttpUrl('https://mcp.example.com/sse'), 'ok');
  assert.equal(checkMcpHttpUrl('http://localhost:8080/mcp'), 'ok');
  assert.equal(checkMcpHttpUrl('http://127.0.0.1:3000'), 'ok');
  assert.equal(checkMcpHttpUrl('http://[::1]:3000/mcp'), 'ok');
  assert.equal(checkMcpHttpUrl('not-a-url'), 'invalid');
  for (const unsafe of [
    'http://example.com/mcp',
    'https://user:pass@example.com/mcp',
    'https://example.com/mcp?token=abc',
    'https://example.com/mcp#frag',
  ]) {
    assert.equal(checkMcpHttpUrl(unsafe), 'unsafe', unsafe);
    const res = validateExtensionInput({
      kind: 'mcp',
      name: 'remote-mcp',
      description: '',
      enabled: true,
      transport: { type: 'http', url: unsafe },
    });
    assert.equal(res.ok, false, unsafe);
    if (!res.ok) assert.equal(res.code, 'unsafe_url');
  }

  const badUrl = validateExtensionInput({
    kind: 'mcp',
    name: 'remote-mcp',
    description: '',
    enabled: true,
    transport: { type: 'http', url: 'not-a-url' },
  });
  assert.equal(badUrl.ok, false);
  if (!badUrl.ok) assert.equal(badUrl.code, 'invalid_url');

  const badToken = validateExtensionInput({
    kind: 'mcp',
    name: 'token-mcp',
    description: '',
    enabled: true,
    transport: { type: 'http', url: 'https://example.com/mcp', tokenEnv: 'lowercase_token' },
  });
  assert.equal(badToken.ok, false);
  if (!badToken.ok) assert.equal(badToken.code, 'invalid_token_env');

  const badEnv = validateExtensionInput({
    kind: 'mcp',
    name: 'stdio-mcp',
    description: '',
    enabled: true,
    transport: {
      type: 'stdio',
      command: '/usr/bin/node',
      args: [],
      envNames: ['lower_env'],
    },
  });
  assert.equal(badEnv.ok, false);
  if (!badEnv.ok) assert.equal(badEnv.code, 'invalid_env_name');

  assert.equal(isAbsoluteExecutablePath('/usr/bin/node'), true);
  assert.equal(isAbsoluteExecutablePath('C:\\tools\\mcp.exe'), true);
  assert.equal(isAbsoluteExecutablePath('node'), false);
  assert.equal(isAbsoluteExecutablePath('/usr/bin/node\0bad'), false);

  const relativeCommand = validateExtensionInput({
    kind: 'mcp',
    name: 'stdio-mcp',
    description: '',
    enabled: true,
    transport: {
      type: 'stdio',
      command: 'relative-bin',
      args: [],
      envNames: ['API_TOKEN_1'],
    },
  });
  assert.equal(relativeCommand.ok, false);
  if (!relativeCommand.ok) assert.equal(relativeCommand.code, 'invalid_command');

  const validStdio = validateExtensionInput({
    kind: 'mcp',
    name: 'stdio-mcp',
    description: '',
    enabled: true,
    transport: {
      type: 'stdio',
      command: '/usr/bin/node',
      args: ['--stdio'],
      envNames: ['API_TOKEN_1'],
      keepAlive: true,
    },
  });
  assert.equal(validStdio.ok, true);
});

test('classifyExtensionDiagnostic classifies static, dynamic, and unknown diagnostics', () => {
  assert.deepEqual(classifyExtensionDiagnostic(extensionDiagnosticMessages.emptyBody), {
    code: 'empty_body',
  });
  assert.deepEqual(classifyExtensionDiagnostic(extensionDiagnosticMessages.unsupportedPackage), {
    code: 'unsupported_package',
  });
  assert.deepEqual(classifyExtensionDiagnostic('已发现 12 项工具。'), {
    code: 'discovered_tools',
    count: 12,
  });
  assert.deepEqual(classifyExtensionDiagnostic('请在本机服务环境中设置 GITHUB_TOKEN。'), {
    code: 'environment_required',
    name: 'GITHUB_TOKEN',
  });
  assert.equal(classifyExtensionDiagnostic('upstream custom diagnostic'), undefined);
  assert.equal(classifyExtensionDiagnostic(undefined), undefined);
});
