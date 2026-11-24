/**
 * @file 验证模型规划前的凭据识别与误判防护。
 * @implementation 使用合成值覆盖常见密钥、硬编码字面值、源码引用和明确占位符，核对模型披露限制。
 * @updated 2026-11-24T21:39:03+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { canSendCommitDiff } from '../server/modules/git/commit-plan-privacy.js';

const assignmentLine = (field: string, value: string, operator = ' = ') =>
  `${field}${operator}${value}`;
const providerSample = ['ghp', '12345678901234567890'].join('_');

test('quoted JSON and JavaScript credentials are withheld from model input', () => {
  const sampleValue = 'SYNTHETIC_CREDENTIAL_123456';
  for (const sample of [
    ...['password', 'api_key', 'token', 'secret'].map((field) =>
      assignmentLine(`+${JSON.stringify(field)}`, JSON.stringify(sampleValue), ': '),
    ),
    assignmentLine('+token', sampleValue),
    assignmentLine('+secret', sampleValue),
    assignmentLine("+'client_secret'", `'${sampleValue}'`, ': '),
    assignmentLine('+AWS_SECRET_ACCESS_KEY', sampleValue, '='),
    ['+-----BEGIN', 'PRIVATE KEY-----'].join(' '),
    `+${providerSample}`,
  ])
    assert.equal(canSendCommitDiff(sample), false, sample);
  assert.equal(canSendCommitDiff('+const title = "Improve local preview";'), true);
});

test('credential-like variable names in source do not make references and explicit placeholders secret', () => {
  for (const sample of [
    '+const token = currentToken;',
    '+const token = atEnd(text);',
    "+const token = triggerAt('please check @styl', 18, 18)!;",
    '+const refreshToken = process.env.REFRESH_TOKEN;',
    '+const token: string = currentToken;',
    '+const token = "test-token";',
    assignmentLine('+password', '${MY_PASSWORD}', ': '),
    '+const magicToken = "placeholder";',
    '+const tokenizer = "validate-sentence";',
    '+if (token === expectedToken) return true;',
  ])
    assert.equal(canSendCommitDiff(sample), true, sample);
});

test('indirect and fixture syntax do not suppress known credential formats or hardcoded values', () => {
  for (const sample of [
    assignmentLine('const token', `atEnd("${providerSample}");`),
    assignmentLine('const token', '"test-token-a234xaffaf";'),
    assignmentLine('const token', '"secret with spaces";'),
    assignmentLine('const token: string', '"secret with a type";'),
    assignmentLine('Authorization', 'Bearer eY0p6qD8zcJ7Vk0w', ': '),
    assignmentLine('const token', '"test-token-x9Z2";', ' =\n  '),
    assignmentLine('password', 'longlowercasepassword'),
    assignmentLine('export API_KEY', 'Kvv2Axf.TYPh72av', '='),
    assignmentLine('token', 'values.us', '='),
  ])
    assert.equal(canSendCommitDiff(sample), false, sample);
});
