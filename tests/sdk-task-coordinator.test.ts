/**
 * @file 验证 ToolInvocationGate、SubagentRun 分支中止、SdkTaskCoordinator 与 tool-evidence 的纯内存行为。
 * @implementation 覆盖一次性票据核销与吊销、目录写锁串行化、分支 stop 顺序、统一前后台任务视图及无状态工具证据投影。
 * @updated 2026-11-27T19:52:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolCall } from '../shared/types.js';
import { NativeBashTasks } from '../server/native-bash.js';
import { SdkTaskCoordinator } from '../server/modules/runs/sdk-task-coordinator.js';
import {
  callHash,
  ProjectWrites,
  ToolInvocationGate,
} from '../server/modules/runs/tool-invocation-gate.js';
import { SubagentRun } from '../server/subagent-run.js';
import {
  checkpointReference,
  checkpointToolRecord,
  checkpointUserExcerpt,
} from '../server/tool-evidence.js';

const run = { id: 'run-1', sessionId: 'session-1' };
const sdkSessionId = 'sdk-session-1';

test('ToolInvocationGate enforces one-time hash-bound tickets and actor revocation', () => {
  const activeActors = new Set(['sub-a', 'sub-b']);
  const gate = new ToolInvocationGate((id) => activeActors.has(id));

  assert.equal(
    callHash('mcp__atelier__list_files', {}),
    callHash('mcp__atelier__list_files', { path: '' }),
  );
  assert.equal(
    callHash('mcp__atelier__write_file', { b: 2, a: 1 }),
    callHash('mcp__atelier__write_file', { a: 1, b: 2 }),
  );

  const mainTicket = gate.issue('tool-main', 'mcp__atelier__write_file', { path: 'a.txt' });
  // Mismatched tool name or arguments do not consume the ticket.
  assert.equal(gate.claim(mainTicket, 'mcp__atelier__edit_file', { path: 'a.txt' }), undefined);
  assert.equal(gate.claim(mainTicket, 'mcp__atelier__write_file', { path: 'b.txt' }), undefined);
  assert.equal(gate.claim(123, 'mcp__atelier__write_file', { path: 'a.txt' }), undefined);

  const claimed = gate.claim(mainTicket, 'mcp__atelier__write_file', { path: 'a.txt' });
  assert.equal(claimed?.id, 'tool-main');
  assert.equal(claimed?.subagentId, undefined);
  // One-time consumption: replay fails.
  assert.equal(gate.claim(mainTicket, 'mcp__atelier__write_file', { path: 'a.txt' }), undefined);

  const ticketA = gate.issue('tool-a', 'mcp__atelier__read_file', { path: 'x' }, 'sub-a');
  const ticketB = gate.issue('tool-b', 'mcp__atelier__read_file', { path: 'y' }, 'sub-b');
  gate.revokeForActor('sub-a');
  assert.equal(gate.claim(ticketA, 'mcp__atelier__read_file', { path: 'x' }), undefined);

  // Inactive actor cannot claim even if revokeForActor was not yet called.
  activeActors.delete('sub-b');
  assert.equal(gate.claim(ticketB, 'mcp__atelier__read_file', { path: 'y' }), undefined);

  // clear() revokes remaining tickets.
  const remaining = gate.issue('tool-c', 'mcp__atelier__list_files', {});
  gate.clear();
  assert.equal(gate.claim(remaining, 'mcp__atelier__list_files', { path: '' }), undefined);
});

test('ProjectWrites serializes writes per directory and releases lock after failure', async () => {
  const writes = new ProjectWrites();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = writes.run(
    () => {
      order.push('verify-1');
    },
    async () => {
      order.push('effect-1-start');
      await firstGate;
      order.push('effect-1-end');
      return 'ok-1';
    },
    '/repo-a',
  );
  const second = writes.run(
    () => {
      order.push('verify-2');
    },
    async () => {
      order.push('effect-2');
      return 'ok-2';
    },
    '/repo-a',
  );
  const parallelOtherDir = writes.run(
    () => {
      order.push('other-dir-verify');
    },
    async () => {
      order.push('other-dir-effect');
      return 'other';
    },
    '/repo-b',
  );

  assert.equal(await parallelOtherDir, 'other');
  assert.ok(order.includes('effect-1-start'));
  assert.ok(order.includes('other-dir-effect'));
  assert.ok(!order.includes('verify-2'));
  assert.ok(!order.includes('effect-2'));

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['ok-1', 'ok-2']);
  assert.ok(order.indexOf('effect-1-end') < order.indexOf('verify-2'));
  assert.ok(order.indexOf('verify-2') < order.indexOf('effect-2'));

  await assert.rejects(
    writes.run(
      () => {
        throw new Error('verify-failed');
      },
      async () => 'never',
      '/repo-a',
    ),
    /verify-failed/,
  );
  assert.equal(
    await writes.run(
      () => {},
      async () => 'recovered',
      '/repo-a',
    ),
    'recovered',
  );
});

test('SubagentRun owns branch AbortController lifecycle and preserves stopTask-before-abort order', async () => {
  const events: string[] = [];
  const subagents = new SubagentRun(
    run,
    sdkSessionId,
    true,
    {
      startSubagent: (entry) => events.push(`start:${entry.id}`),
      finishSubagent: (id, _runId, status) => events.push(`finish:${id}:${status}`),
    },
    (id, status) => events.push(`cb:${id}:${status}`),
  );

  const id = `${run.id}:use-agent-1`;
  subagents.reserve(id, 'use-agent-1', {
    description: 'Inspect module',
    prompt: 'Check exports',
    subagent_type: 'atelier-explore',
  });
  await assert.rejects(
    subagents.stop(
      {
        stopTask: async () => {
          events.push('unexpected-stop');
        },
      },
      id,
    ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'SUBAGENT_NOT_ACTIVE',
  );

  subagents.started({
    session_id: sdkSessionId,
    task_id: 'sdk-agent-1',
    task_type: 'local_agent',
    tool_use_id: 'use-agent-1',
  });

  const branchSignal = subagents.ensureBranchSignal(id);
  assert.equal(branchSignal.aborted, false);
  assert.equal(subagents.branchSignal(id), branchSignal);
  assert.equal(subagents.isActive(id), true);

  let signalAbortedDuringStopCall: boolean | undefined;
  await subagents.stop(
    {
      stopTask: async (taskId) => {
        events.push(`stopTask:${taskId}`);
        signalAbortedDuringStopCall = branchSignal.aborted;
      },
    },
    id,
  );
  assert.equal(signalAbortedDuringStopCall, false);
  assert.equal(branchSignal.aborted, true);

  subagents.finish(id, 'stopped', '用户已停止。');
  assert.equal(subagents.isActive(id), false);
  assert.equal(subagents.branchSignal(id), undefined);
  assert.deepEqual(events, [
    `start:${id}`,
    'stopTask:sdk-agent-1',
    `finish:${id}:stopped`,
    `cb:${id}:stopped`,
  ]);

  // close() aborts any remaining active branch signal.
  const id2 = `${run.id}:use-agent-2`;
  subagents.reserve(id2, 'use-agent-2', {
    description: 'Second branch',
    prompt: 'Inspect tests',
    subagent_type: 'atelier-worker',
  });
  subagents.started({
    session_id: sdkSessionId,
    task_id: 'sdk-agent-2',
    task_type: 'local_agent',
    tool_use_id: 'use-agent-2',
  });
  const branch2Signal = subagents.ensureBranchSignal(id2);
  assert.equal(branch2Signal.aborted, false);
  subagents.close('interrupted', '父运行结束。');
  assert.equal(branch2Signal.aborted, true);
  assert.equal(subagents.active, false);
});

test('SdkTaskCoordinator routes task frames and maintains one authoritative foreground view', async () => {
  const finishedAgents: string[] = [];
  const bashUpdates: string[] = [];
  const subagents = new SubagentRun(
    run,
    sdkSessionId,
    true,
    {
      startSubagent: () => {},
      finishSubagent: () => {},
    },
    (id, status) => finishedAgents.push(`${id}:${status}`),
  );
  const bash = new NativeBashTasks(sdkSessionId, (id, execution) => {
    bashUpdates.push(`${id}:${execution.phase}`);
  });
  const coordinator = new SdkTaskCoordinator(subagents, bash);

  const agentId = `${run.id}:use-agent`;
  const bashId = `${run.id}:use-bash`;
  const childToolId = `${run.id}:sdk-agent:use-child`;

  subagents.reserve(agentId, 'use-agent', {
    description: 'Worker task',
    prompt: 'Do work',
    subagent_type: 'atelier-worker',
  });
  coordinator.trackTool(agentId, { useId: 'use-agent' });
  bash.register(bashId, 'use-bash');
  coordinator.trackTool(bashId, { useId: 'use-bash' });
  coordinator.trackTool(childToolId, { useId: 'use-child', subagentId: agentId });

  coordinator.handleStarted({
    session_id: sdkSessionId,
    task_id: 'sdk-agent',
    task_type: 'local_agent',
    tool_use_id: 'use-agent',
  });
  coordinator.handleStarted({
    session_id: sdkSessionId,
    task_id: 'sdk-bash',
    task_type: 'local_bash',
    tool_use_id: 'use-bash',
  });

  // Child tool belongs to subagent and is excluded from top-level foreground tools.
  assert.deepEqual(coordinator.foregroundTools(), [agentId, bashId]);
  assert.equal(coordinator.isForeground(agentId), true);
  assert.equal(coordinator.isForeground(childToolId), false);
  assert.equal(coordinator.canBackground(agentId), true);
  assert.equal(coordinator.canBackground(bashId), true);
  assert.equal(coordinator.hasActiveSubagents, true);
  assert.equal(coordinator.hasDeferredWork, false);

  // Duplicate useId blocks backgrounding that tool safely.
  coordinator.trackTool('dup-tool', { useId: 'use-bash', subagentId: agentId });
  assert.equal(coordinator.canBackground(bashId), false);
  coordinator.untrackTool('dup-tool');
  assert.equal(coordinator.canBackground(bashId), true);

  const backgrounded: string[] = [];
  const sdk = {
    backgroundTasks: async (useId?: string) => {
      if (useId) backgrounded.push(useId);
      return true;
    },
    stopTask: async () => {},
  };
  await coordinator.backgroundTool(sdk, agentId);
  assert.deepEqual(backgrounded, ['use-agent']);
  assert.deepEqual(coordinator.foregroundTools(), [bashId]);
  assert.equal(coordinator.hasDeferredWork, true);

  // task_updated transitions bash into background cleanly.
  coordinator.handleUpdated({
    session_id: sdkSessionId,
    task_id: 'sdk-bash',
    patch: { is_backgrounded: true },
  });
  assert.deepEqual(coordinator.foregroundTools(), []);
  assert.ok(bashUpdates.includes(`${bashId}:background`));

  // task_notification routes to the owning domain cleanly.
  subagents.report(agentId, { status: 'async_launched', agentId: 'sdk-agent' });
  const agentNotice = coordinator.handleNotification({
    session_id: sdkSessionId,
    task_id: 'sdk-agent',
    status: 'completed',
    summary: 'Agent done',
  });
  assert.equal(agentNotice.subagentFinished, true);
  assert.equal(agentNotice.bashReceipt, undefined);
  assert.deepEqual(finishedAgents, [`${agentId}:completed`]);

  bash.handedOff(bashId, { backgroundTaskId: 'sdk-bash' });
  const bashNotice = coordinator.handleNotification({
    session_id: sdkSessionId,
    task_id: 'sdk-bash',
    status: 'completed',
    output_file: '/tmp/out.log',
    summary: 'Bash done',
  });
  assert.equal(bashNotice.subagentFinished, false);
  assert.equal(bashNotice.bashReceipt?.id, bashId);
});

test('tool-evidence projects redacted excerpts, sources, and operation outcomes without HarnessProgress', () => {
  const secretText = 'Token sk-ant-api03-1234567890abcdefghijklmnop in request';
  assert.ok(!checkpointUserExcerpt(secretText).includes('sk-ant-api03'));
  assert.match(checkpointReference('invalid reference with spaces'), /^ref:[0-9a-f]{24}$/);

  const fetchTool: ToolCall = {
    id: 'tool-fetch-1',
    runId: 'run-1',
    sessionId: 'session-1',
    name: 'WebFetch',
    inputSummary: JSON.stringify({
      url: 'https://user:pass@docs.example.com/guide?token=secret#top',
    }),
    status: 'succeeded',
    output: 'Fetched https://docs.example.com/guide?token=secret',
    startedAt: '2026-11-27T10:00:00.000Z',
    endedAt: '2026-11-27T10:00:01.000Z',
  };
  const record = checkpointToolRecord(fetchTool);
  assert.equal(record.evidence.operation, 'read');
  assert.equal(record.evidence.outcome, 'completed');
  assert.equal(record.fetchedSource?.url, 'https://docs.example.com/guide');
  assert.equal(record.sideEffect, 'none');
});
