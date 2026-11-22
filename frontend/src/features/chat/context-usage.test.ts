/**
 * @file 验证输入框上下文快照的会话与模型归属。
 * @implementation 用历史、运行中和已切换的 SDK 会话记录测试样本选择。
 * @updated 2026-11-23T03:40:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextUsage } from '@shared/context-usage';
import { selectContextUsage } from './context-usage-model';

const context: ContextUsage = {
  capturedAt: '2026-11-23T00:00:00.000Z',
  sdkSessionId: 'old-sdk',
  model: 'model-a',
  usedTokens: 20,
  windowTokens: 100,
  categories: [],
  requestUsage: null,
};
const config = { gateway: 'http://localhost', model: 'model-a', maxTurns: 10, timeoutMs: 60_000 };
const run = { id: 'run-a', config, contextUsage: context };

test('context samples distinguish previous runs and model selections', () => {
  assert.deepEqual(selectContextUsage([run], 'old-sdk', undefined, 'model-a'), {
    context,
    previous: false,
  });
  assert.equal(selectContextUsage([run], 'old-sdk', 'run-b', 'model-a')?.previous, true);
  assert.equal(selectContextUsage([run], 'old-sdk', undefined, 'model-b')?.previous, true);
  assert.equal(
    selectContextUsage([run, { id: 'run-b', config }], 'old-sdk', undefined, 'model-a')?.previous,
    true,
  );
});

test('new SDK sessions and historical runs without metrics start without a sample', () => {
  assert.equal(selectContextUsage([run], 'new-sdk', undefined, 'model-a'), undefined);
  assert.equal(selectContextUsage([run], null, undefined, 'model-a'), undefined);
  assert.equal(
    selectContextUsage([{ id: 'run-legacy', config }], 'old-sdk', undefined, 'model-a'),
    undefined,
  );
});
