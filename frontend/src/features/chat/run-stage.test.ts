/**
 * @file 验证有序和旧版对话共用的运行阶段。
 * @implementation 用合成运行、事件、工具和子任务核对优先级、等待时效及中英文工具名称。
 * @updated 2026-11-27T16:57:00+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uiI18n } from '@/i18n';
import type { RunEvent, ToolCall } from '@shared/types';
import { deriveRunStage } from './run-stage';

const at = '2026-11-27T00:00:00.000Z';
const now = Date.parse(at) + 500;
const run = { id: 'run', sessionId: 'session', status: 'running' as const };
const event = (type: RunEvent['type']): RunEvent => ({
  id: 1,
  seq: 1,
  runId: run.id,
  sessionId: run.sessionId,
  at,
  type,
  payload: {},
});
const tool = (name: string, extra?: Partial<ToolCall>): ToolCall => ({
  id: 'tool',
  runId: run.id,
  sessionId: run.sessionId,
  name,
  status: 'running',
  inputSummary: '',
  output: '',
  startedAt: at,
  endedAt: null,
  ...extra,
});
const stage = (input: Partial<Parameters<typeof deriveRunStage>[0]> = {}, language = 'en') =>
  deriveRunStage({ run, now, tools: [], events: [], ...input }, uiI18n.getFixedT(language, 'chat'));

test('stop pending overrides retry and is reflected in the displayed run status', () => {
  const events = [event('sdk.api_retry')];
  assert.equal(stage({ events }).label, 'Waiting for the model retry result');
  const stopping = stage({ events, stopPending: true }, 'zh-CN');
  assert.equal(stopping.status, 'stopping');
  assert.equal(stopping.label, '正在停止');
  assert.equal(stage({ events, run: { ...run, status: 'stopping' } }).key, 'progress.stopping');
});

test('foreground and preparing tools use the localized shared names', () => {
  const tools = [tool('mcp__atelier__edit_file')];
  assert.equal(stage({ tools }).label, 'Calling Edit file');
  assert.equal(stage({ tools }, 'zh-CN').label, '正在调用 编辑文件');
  const notices = [
    { kind: 'tool_preparing' as const, toolCallId: 'read', toolName: 'Read', at, order: 1 },
  ];
  assert.equal(stage({ notices }).label, 'Preparing Read file');
  assert.equal(stage({ notices }, 'zh-CN').label, '正在准备 读取文件');
  assert.equal(stage({ tools: [tool('mcp__atelier__toString')] }).label, 'Calling toString');
});

test('subtasks, retries, background Bash and recent replies share a single priority order', () => {
  const bash = tool('Bash', {
    bashExecution: { phase: 'background', controllable: true, lastObservedAt: at },
  });
  const worker = {
    id: 'worker',
    runId: run.id,
    sessionId: run.sessionId,
    status: 'running' as const,
  };
  const delta = event('message.delta');
  const retry = event('sdk.api_retry');
  assert.equal(
    stage({
      tools: [bash, tool('Agent', { id: worker.id }), tool('Read', { subagentId: worker.id })],
      subagents: [worker, { ...worker, sessionId: 'other' }],
      events: [delta, retry],
    }).label,
    'Running subtask · 1 in progress',
  );
  assert.equal(stage({ tools: [bash], events: [delta, retry] }).key, 'progress.retryingModel');
  assert.equal(stage({ tools: [bash], events: [delta] }).key, 'progress.backgroundBash');
  assert.equal(stage({ events: [delta] }).key, 'progress.receiving');
  assert.equal(stage({ events: [delta], now: now + 2000 }).key, 'progress.waitingModel');
});
