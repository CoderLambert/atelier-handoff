/**
 * @file 验证工具摘要保留的证据、分页出口和执行者的读取范围。
 * @implementation 以合成日志和已发放的回执 ID 核对统计、原生元数据及跨分支授权。
 * @updated 2026-11-22T19:20:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canReadToolOutput,
  customOutputSummary,
  modelOutputSummary,
  nativeOutputReplacement,
  readOutputName,
} from '../server/tool-output-context.js';

const padding = 'ordinary line\n'.repeat(410);
const sample = `${padding}Error: missing fixture\n17 tests passed\n${padding}last line`;

test('command summaries retain scattered diagnostics, the recorded exit code and truncation state', () => {
  const receipt = { code: 0, truncated: true, output: sample };
  const summary = customOutputSummary(
    'mcp__atelier__run_command',
    'id',
    receipt,
    JSON.stringify(receipt),
  );
  assert.ok(summary && summary.length < 2000);
  for (const fact of [
    '命令退出 0',
    '执行器已截断',
    'Error: missing fixture',
    '17 tests passed',
    'last line',
  ])
    assert.ok(summary.includes(fact), fact);
  assert.equal(customOutputSummary(readOutputName, 'page', sample, sample), undefined);
  const line = '早'.repeat(30000) + '尾';
  assert.ok(modelOutputSummary('id', line, '失败')?.endsWith('尾'));
});

test('native text samples preserve background metadata and pass non-text receipts through', () => {
  const receipt = {
    stdout: sample,
    stderr: 'warning: stderr sample',
    interrupted: false,
    backgroundTaskId: 'task123',
  };
  const value = nativeOutputReplacement('Bash', 'id', receipt, JSON.stringify(receipt))?.value;
  assert.ok(
    value &&
      typeof value === 'object' &&
      'backgroundTaskId' in value &&
      'stdout' in value &&
      typeof value.stdout === 'string',
  );
  assert.equal(value.backgroundTaskId, 'task123');
  for (const fact of ['后台运行中', 'warning: stderr sample', '17 tests passed'])
    assert.ok(value.stdout.includes(fact));
  assert.ok(!value.stdout.includes('退出 0'));
  for (const change of [{ isImage: true }, { structuredContent: [] }])
    assert.equal(
      nativeOutputReplacement('Bash', 'id', { ...receipt, ...change }, sample),
      undefined,
    );
  assert.equal(nativeOutputReplacement('Read', 'id', { type: 'pdf' }, sample), undefined);
  assert.equal(nativeOutputReplacement('Skill', 'id', {}, sample), undefined);
  const web = { result: sample, url: 'https://example.org', code: 200 };
  const replacement = nativeOutputReplacement('WebFetch', 'id', web, JSON.stringify(web));
  assert.deepEqual(replacement?.value, {
    ...web,
    result: modelOutputSummary('id', JSON.stringify(web), '网页回执', sample),
  });
});

test('output grants are run and actor scoped except native main session history', () => {
  const main = { id: 'main', sessionId: 's', runId: 'r' };
  const child = { ...main, id: 'child', subagentId: 'a' };
  const item = { ...main, id: 'result' };
  const granted = new Set([item.id]);
  for (const native of [true, false]) {
    assert.equal(canReadToolOutput(native, main, { ...item, sessionId: 'other' }, granted), false);
    assert.equal(canReadToolOutput(native, child, { ...item, subagentId: 'b' }, granted), false);
    assert.equal(canReadToolOutput(native, child, item, granted), false);
    assert.equal(
      canReadToolOutput(native, child, { ...item, subagentId: 'a', runId: 'old' }, granted),
      false,
    );
    assert.equal(canReadToolOutput(native, child, { ...item, subagentId: 'a' }, new Set()), false);
    assert.equal(canReadToolOutput(native, child, { ...item, subagentId: 'a' }, granted), true);
  }
  assert.equal(canReadToolOutput(true, main, { ...item, runId: 'previous' }, new Set()), true);
  assert.equal(canReadToolOutput(false, main, { ...item, runId: 'previous' }, granted), false);
  assert.equal(canReadToolOutput(false, main, { ...item, subagentId: 'a' }, granted), false);
  assert.equal(canReadToolOutput(false, main, item, new Set()), false);
  assert.equal(canReadToolOutput(false, main, item, granted), true);
});
