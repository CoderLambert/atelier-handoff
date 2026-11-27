/**
 * @file 验证设置草稿纯校验与运行轨迹单趟扫描统计函数。
 * @implementation 覆盖网关地址/模型名/受限执行范围校验、多源轨迹事件合并去重以及单趟摘要与自动审批集合统计。
 * @updated 2026-11-27T22:25:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Permission, RunEvent } from '@shared/types';
import {
  mergeRunTraceEvents,
  scanRunTraceEvents,
  summarizeAutomaticApprovals,
} from './run-trace-facts';
import { normalizeGatewayUrl, validateSettingsDraft } from './settings-validation';

function samplePermission(
  id: string,
  toolCallId: string,
  decisionSource?: Permission['decisionSource'],
): Permission {
  return {
    id,
    runId: 'run-1',
    sessionId: 'sess-1',
    toolCallId,
    kind: 'write',
    path: '/fixture/file.txt',
    command: null,
    before: null,
    after: 'next',
    diff: '',
    baseFingerprint: null,
    version: 'v1',
    status: 'allowed',
    createdAt: '2026-11-27T00:00:00.000Z',
    expiresAt: '2026-11-27T00:02:00.000Z',
    reason: 'fixture',
    ...(decisionSource ? { decisionSource } : {}),
  };
}

function sampleEvent(id: number, seq: number, runId: string, partial: Partial<RunEvent>): RunEvent {
  return {
    id,
    seq,
    runId,
    sessionId: 'sess-1',
    at: '2026-11-27T00:00:00.000Z',
    type: 'sdk.api_retry',
    payload: {},
    ...partial,
  } as RunEvent;
}

test('normalizeGatewayUrl and validateSettingsDraft enforce local gateway and execution bounds', () => {
  assert.equal(normalizeGatewayUrl('  http://127.0.0.1:3001/  '), 'http://127.0.0.1:3001');

  assert.deepEqual(
    validateSettingsDraft({
      usingBundled: true,
      gateway: 'not-a-url',
      model: 'claude-sonnet',
      limitExecution: false,
      maxTurns: 'bad',
      timeoutMs: 'bad',
    }),
    { ok: true, turns: NaN, timeout: NaN, validTurns: false, validTimeout: false },
  );

  assert.deepEqual(
    validateSettingsDraft({
      usingBundled: false,
      gateway: 'bad url',
      model: 'claude-sonnet',
      limitExecution: false,
      maxTurns: '25',
      timeoutMs: '60000',
    }),
    { ok: false, error: { field: 'gateway', messageKey: 'settings.invalidGateway' } },
  );

  assert.deepEqual(
    validateSettingsDraft({
      usingBundled: false,
      gateway: 'https://example.com:3001',
      model: 'claude-sonnet',
      limitExecution: false,
      maxTurns: '25',
      timeoutMs: '60000',
    }),
    { ok: false, error: { field: 'gateway', messageKey: 'settings.invalidGatewayAddress' } },
  );

  assert.deepEqual(
    validateSettingsDraft({
      usingBundled: false,
      gateway: 'http://localhost:3001?token=1',
      model: 'claude-sonnet',
      limitExecution: false,
      maxTurns: '25',
      timeoutMs: '60000',
    }),
    { ok: false, error: { field: 'gateway', messageKey: 'settings.invalidGatewayAddress' } },
  );

  assert.deepEqual(
    validateSettingsDraft({
      usingBundled: true,
      gateway: '',
      model: 'bad model',
      limitExecution: false,
      maxTurns: '25',
      timeoutMs: '60000',
    }),
    { ok: false, error: { field: 'model', messageKey: 'settings.invalidModel' } },
  );

  assert.deepEqual(
    validateSettingsDraft({
      usingBundled: true,
      gateway: '',
      model: 'claude-sonnet',
      limitExecution: true,
      maxTurns: '101',
      timeoutMs: '60000',
    }),
    { ok: false, error: { field: 'turns', messageKey: 'settings.invalidTurns' } },
  );

  assert.deepEqual(
    validateSettingsDraft({
      usingBundled: true,
      gateway: '',
      model: 'claude-sonnet',
      limitExecution: true,
      maxTurns: '25',
      timeoutMs: '9999',
    }),
    { ok: false, error: { field: 'timeout', messageKey: 'settings.invalidTimeout' } },
  );

  assert.deepEqual(
    validateSettingsDraft({
      usingBundled: false,
      gateway: 'http://127.0.0.1:3001',
      model: 'claude-sonnet',
      limitExecution: true,
      maxTurns: '25',
      timeoutMs: '60000',
    }),
    { ok: true, turns: 25, timeout: 60000, validTurns: true, validTimeout: true },
  );
});

test('mergeRunTraceEvents, scanRunTraceEvents, and summarizeAutomaticApprovals compute facts in one pass', () => {
  const merged = mergeRunTraceEvents(
    [
      sampleEvent(1, 2, 'run-1', {
        type: 'sdk.initialized',
        payload: { model: 'old-model', version: '1.0.0' },
      }),
      sampleEvent(2, 4, 'run-1', {
        type: 'run.status_changed',
        payload: { status: 'stopping' },
      }),
    ],
    [
      sampleEvent(3, 1, 'run-1', { type: 'message.delta', payload: { text: 'ignored' } }),
      sampleEvent(4, 3, 'run-2', { type: 'sdk.api_retry', payload: {} }),
      sampleEvent(2, 4, 'run-1', {
        type: 'run.status_changed',
        payload: { status: 'stopping' },
      }),
      sampleEvent(5, 5, 'run-1', {
        type: 'sdk.first_text',
        payload: { elapsedMs: 120 },
      }),
      sampleEvent(6, 6, 'run-1', {
        type: 'sdk.first_text',
        payload: { elapsedMs: 999 },
      }),
      sampleEvent(7, 7, 'run-1', {
        type: 'sdk.initialized',
        payload: { model: 'final-model', version: '1.1.0' },
      }),
      sampleEvent(8, 8, 'run-1', { type: 'sdk.api_retry', payload: {} }),
      sampleEvent(9, 9, 'run-1', { type: 'sdk.api_retry', payload: {} }),
      sampleEvent(10, 10, 'run-1', {
        type: 'skill.invoked',
        payload: { name: 'docx', version: '2', source: 'workspace' },
      }),
      sampleEvent(11, 11, 'run-1', {
        type: 'skills.discovered',
        payload: { count: 3, missingCount: 1 },
      }),
      sampleEvent(12, 12, 'run-1', {
        type: 'sdk.result',
        payload: { turns: 4, httpStatus: 200, apiDurationMs: 450, stopReason: 'end_turn' },
      }),
      sampleEvent(13, 13, 'run-1', {
        type: 'process.exited',
        payload: { code: 0, signal: null },
      }),
    ],
    'run-1',
  );

  assert.deepEqual(
    merged.map((event) => event.seq),
    [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  );

  const summary = scanRunTraceEvents(merged);
  assert.equal(summary.stopSequence, 4);
  assert.equal(summary.init?.model, 'final-model');
  assert.equal(summary.firstText?.elapsedMs, 120);
  assert.equal(summary.result?.turns, 4);
  assert.equal(summary.exit?.code, 0);
  assert.equal(summary.retryCount, 2);
  assert.equal(summary.invokedPayloads.length, 1);
  assert.deepEqual(summary.discovered, { count: 3, missingCount: 1 });

  const approvals = summarizeAutomaticApprovals([
    samplePermission('p1', 'tool-a', 'automatic'),
    samplePermission('p2', 'tool-b'),
    samplePermission('p3', 'tool-c', 'automatic'),
  ]);
  assert.equal(approvals.count, 2);
  assert.deepEqual([...approvals.toolIds], ['tool-a', 'tool-c']);
});
