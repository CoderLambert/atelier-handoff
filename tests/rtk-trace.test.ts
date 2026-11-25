/**
 * @file 验证内置 RTK 轨迹契约、历史兼容及按工具持久化。
 * @implementation 使用合成命令和隔离 SQLite 检查元数据校验、会话隔离、未确认调用及重新打开后的快照。
 * @updated 2026-11-26T01:33:50+08:00
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeRecord, records } from '../server/db/mappers/session-records.js';
import { Store } from '../server/store.js';
import { rtkTraceSchema } from '../shared/rtk-trace.js';
import type { ToolCall } from '../shared/types.js';

const at = '2026-11-26T00:00:00.000Z';
const rtk = rtkTraceSchema.parse({
  hook: 'builtin-rtk',
  originalCommand: 'git status',
  executedCommand: "'/fixture/RTK binary' git status",
});
function tool(id: string, patch: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    sessionId: 'fixture-session',
    runId: 'fixture-run',
    name: 'Bash',
    inputSummary: 'rtk git status',
    status: 'succeeded',
    output: 'historical output',
    startedAt: at,
    endedAt: at,
    ...patch,
  };
}

test('RTK trace schema requires a built-in hook and both complete commands without changing their text', () => {
  assert.deepEqual(rtkTraceSchema.parse(rtk), rtk);
  for (const invalid of [
    null,
    {},
    { ...rtk, hook: 'user-script' },
    { ...rtk, originalCommand: undefined },
    { ...rtk, originalCommand: '' },
    { ...rtk, executedCommand: undefined },
    { ...rtk, executedCommand: '' },
    { ...rtk, executedCommand: 1 },
  ]) {
    assert.equal(rtkTraceSchema.safeParse(invalid).success, false);
  }
});

test('tool record decoding accepts historical data, preserves confirmed RTK traces and rejects malformed metadata', () => {
  const historical = tool('historical-tool');
  const decode = (value: object) =>
    decodeRecord(records.tools, { id: historical.id, data: JSON.stringify(value) });
  assert.deepEqual(decode(historical), historical);
  assert.equal(decode(historical).rtk, undefined);
  for (const status of ['succeeded', 'failed'] as const) {
    const confirmed = { ...historical, status, rtk };
    assert.deepEqual(decode(confirmed), confirmed);
  }
  for (const invalid of [
    null,
    {},
    { ...rtk, hook: 'unverified' },
    { ...rtk, executedCommand: 1 },
  ]) {
    assert.throws(() => decode({ ...historical, rtk: invalid }), {
      code: 'INVALID_STORED_RECORD',
    });
  }
});

test('session snapshots retain per-tool RTK traces across reopen while historical and unconfirmed calls stay unmarked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-rtk-trace-'));
  let store: Store | undefined;
  try {
    store = new Store(directory);
    const historical = tool('historical-tool');
    const confirmed = tool('confirmed-tool', { command: rtk.originalCommand, rtk });
    const failed = tool('failed-tool', {
      command: rtk.originalCommand,
      status: 'failed',
      output: '{"stdout":"","stderr":"fixture failure","exitCode":7}',
      rtk,
    });
    const unconfirmed = tool('unconfirmed-tool', {
      command: rtk.executedCommand,
      status: 'denied',
    });
    const foreign = tool('foreign-tool', { sessionId: 'other-session' });
    for (const value of [historical, confirmed, failed, unconfirmed, foreign]) {
      store.put('tools', value);
    }
    const expected = [historical, confirmed, failed, unconfirmed];
    assert.deepEqual(store.sessionSnapshots.readRecovery(historical.sessionId).tools, expected);
    assert.deepEqual(store.sessionSnapshots.readRecovery(foreign.sessionId).tools, [foreign]);
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.sessionSnapshots.readRecovery(historical.sessionId).tools, expected);
    assert.deepEqual(store.sessionSnapshots.readRecovery(foreign.sessionId).tools, [foreign]);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
