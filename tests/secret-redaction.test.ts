/**
 * @file 检查诊断信息和恢复上下文的凭据脱敏。
 * @implementation 用合成凭据覆盖固定模式、动态环境值与两种 URL 投影。
 * @updated 2026-11-27T16:57:00+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets } from '../server/secret-redaction.js';

test('both redaction modes scrub configured tokens and common credential formats', () => {
  const env = {
    ANTHROPIC_API_KEY: 'fixture-local',
    ATELIER_GATEWAY_TOKEN: 'fixture-local-extended',
    ANTHROPIC_AUTH_TOKEN: 'fixture auth value',
  };
  const secrets = [
    env.ANTHROPIC_API_KEY,
    env.ATELIER_GATEWAY_TOKEN,
    env.ANTHROPIC_AUTH_TOKEN,
    'basic-fixture=',
    'bearer~fixture',
    'enclosed-bearer-fixture',
    'sk-ant-A1b2C3d4',
    'sk_ant_A1b2C3d4',
    'eyJabc.fixture.parts',
    'AKIA0123456789ABCDEF',
    'local fixture password',
    'unquoted-fixture-password',
    'fixture-key-content',
  ];
  const input = [
    secrets[0],
    secrets[1],
    'Bearer fixture auth value',
    'Authorization: Basic basic-fixture=',
    'Bearer bearer~fixture',
    'Authorization: Bearer <enclosed-bearer-fixture>',
    'sk-ant-A1b2C3d4 sk_ant_A1b2C3d4 eyJabc.fixture.parts AKIA0123456789ABCDEF',
    'password="local fixture password" password=unquoted-fixture-password',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-key-content',
  ].join('\n');
  for (const mode of ['diagnostic', 'checkpoint'] as const) {
    const output = redactSecrets(input, mode, env);
    for (const secret of secrets) assert.ok(!output.includes(secret), secret);
    assert.doesNotMatch(output, /extended|PRIVATE KEY/);
    assert.match(output, /password=/);
  }
});

test('checkpoints remove URL metadata while diagnostics preserve noncredential query parameters', () => {
  const input =
    'Fetch https://fixture-user:fixture-pass@example.org/guide?token=fixture-token&page=2#intro';
  assert.equal(
    redactSecrets(input, 'diagnostic', {}),
    'Fetch https://[已隐藏]@example.org/guide?token=[已隐藏]&page=2#intro',
  );
  assert.equal(
    redactSecrets(input + '\u0000', 'checkpoint', {}),
    'Fetch https://example.org/guide',
  );
  assert.equal(redactSecrets('plain text', 'checkpoint', {}), 'plain text');
});
