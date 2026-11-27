/**
 * @file 测试对话内定时任务卡片的工具结果解析与摘要格式化逻辑。
 * @implementation 验证 create/update_scheduled_task 成功输出能还原完整任务对象、忽略失败或无关工具输出，并正确展示按需触发摘要。
 * @updated 2026-11-27T15:20:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolCall } from '@shared/types';
import { formatScheduleSummary, parseScheduledTaskFromTool } from './schedule-card';

function sampleTool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    name: 'mcp__atelier__create_scheduled_task',
    inputSummary: 'create_scheduled_task',
    status: 'succeeded',
    output: JSON.stringify({
      task: {
        id: 'task-1',
        projectId: 'proj-1',
        slug: 'daily-sync',
        targetMode: 'new_once',
        targetSessionId: null,
        agentRevisionId: null,
        title: '定时检查分支同步',
        prompt: 'git fetch && git status',
        timing: { kind: 'daily', time: '09:00', everyDays: 1 },
        timeZone: 'Asia/Shanghai',
        mode: 'readonly',
        approvalMode: null,
        maxSearchChargeFen: 0,
        timeoutMs: null,
        misfirePolicy: 'run_once',
        overlapPolicy: 'skip',
        notifyPolicy: 'on_error',
        remoteTriggerEnabled: false,
        hasTriggerToken: false,
        status: 'active',
        pauseReason: null,
        nextRunAt: '2026-11-28T01:00:00.000Z',
        lastRunAt: null,
        consecutiveFailures: 0,
        createdBy: 'agent',
        createdSessionId: 'sess-1',
        createdAt: '2026-11-27T01:00:00.000Z',
        updatedAt: '2026-11-27T01:00:00.000Z',
      },
    }),
    startedAt: '2026-11-27T01:00:00.000Z',
    endedAt: '2026-11-27T01:00:01.000Z',
    ...overrides,
  };
}

test('parseScheduledTaskFromTool extracts valid task from create/update schedule tool calls', () => {
  const parsed = parseScheduledTaskFromTool(sampleTool());
  assert.ok(parsed);
  assert.equal(parsed.id, 'task-1');
  assert.equal(parsed.slug, 'daily-sync');
  assert.equal(parsed.title, '定时检查分支同步');

  assert.equal(parseScheduledTaskFromTool(sampleTool({ status: 'failed' })), undefined);
  assert.equal(
    parseScheduledTaskFromTool(sampleTool({ name: 'mcp__atelier__list_files' })),
    undefined,
  );
  assert.equal(parseScheduledTaskFromTool(sampleTool({ output: 'not-json' })), undefined);
});

test('formatScheduleSummary handles manual on-demand timing', () => {
  const summary = formatScheduleSummary(
    { timing: { kind: 'manual' }, timeZone: 'Asia/Shanghai' },
    (key) => key,
  );
  assert.equal(summary, 'timing.manual');
});
