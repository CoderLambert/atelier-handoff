/**
 * @file 验证实时插话、SDK 确认与输入排空的状态转换。
 * @implementation 用内存输入流、前台任务替身和手动时钟复现派发冲突、迟到回执、后台交接与空闲结算。
 * @updated 2026-11-27T17:49:36+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import {
  InputQueue,
  LiveTurnCoordinator,
  sdkInputIds,
  type AttachmentImages,
  type LiveInput,
} from '../server/modules/runs/live-turn-coordinator.js';
import { AppError } from '../shared/types.js';

const sessionId = 'sdk-session';
const initialId = '00000000-0000-4000-8000-000000000001';
const nextId = '00000000-0000-4000-8000-000000000002';
const laterId = '00000000-0000-4000-8000-000000000003';
const flush = () => assert.fail('No deferred work should need a transcript flush');

function result(...inputs: string[]): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 10,
    duration_api_ms: 5,
    is_error: false,
    num_turns: 1,
    result: 'model answer',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      fallback_credit: null,
      inference_geo: '',
      input_tokens: 1,
      iterations: [],
      output_tokens: 1,
      output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: 'standard',
      speed: 'standard',
    },
    modelUsage: {},
    permission_denials: [],
    uuid: initialId,
    session_id: sessionId,
    user_message_uuids: inputs,
  };
}

function fixture(native = true, idleTimeoutMs?: number) {
  const cancellation = new AbortController();
  const runningTools = new Map<string, { useId?: string; subagentId?: string }>();
  const movableAgents = new Set<string>();
  const movableBash = new Set<string>();
  const background = new Set<string>();
  const state = {
    localWork: false,
    activeAgents: false,
    deferredAgents: false,
    deferredBash: false,
  };
  const live: { insert?: (message: LiveInput) => void | Promise<void> } = {};
  const trace: string[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;

  const sdk = {
    async backgroundTasks(useId?: string) {
      trace.push(`background:${useId}`);
      return true;
    },
    async stopTask() {
      assert.fail('Insertion should only move tasks to the background');
    },
  };
  const turn = new LiveTurnCoordinator({
    native,
    sdkSessionId: sessionId,
    signal: cancellation.signal,
    liveInput: live,
    runningTools,
    subagents: {
      get active() {
        return state.activeAgents;
      },
      get hasBackground() {
        return state.deferredAgents;
      },
      isBackground: (id) => background.has(id),
      canMove: (id) => movableAgents.has(id),
      moveToBackground: async (connection, id) => {
        assert.equal(await connection.backgroundTasks(runningTools.get(id)?.useId), true);
        background.add(id);
        trace.push(`agent:${id}`);
      },
    },
    bash: native
      ? {
          get hasDeferredReceipt() {
            return state.deferredBash;
          },
          isBackground: (id) => background.has(id),
          canMove: (id) => movableBash.has(id),
          control: async (connection, id, action) => {
            assert.equal(action, 'background');
            assert.equal(await connection.backgroundTasks(runningTools.get(id)?.useId), true);
            background.add(id);
            trace.push(`bash:${id}`);
          },
        }
      : undefined,
    blockedByLocalWork: () => state.localWork,
    onInputCheckpoint: () => trace.push('checkpoint'),
    persistInput: ({ id }) => trace.push(`persist:${id}`),
    publishInput: (id) => trace.push(`publish:${id}`),
    acknowledgeTranscriptInput: (id) => trace.push(`transcript:${id}`),
    event: (type, { messageId, receipt }) => trace.push(`${type}:${messageId}:${receipt}`),
    idleTimeoutMs,
    setTimeout(callback, delay) {
      const handle = nextTimer++;
      timers.set(handle, { callback, delay });
      return handle;
    },
    clearTimeout(handle) {
      assert.equal(typeof handle, 'number');
      if (typeof handle === 'number') timers.delete(handle);
    },
  });
  assert.equal(turn.onInitialized(sdk), true);
  const input = (overrides: Partial<LiveInput> = {}): LiveInput => ({
    id: nextId,
    text: 'follow up',
    dispatched: () => trace.push('dispatched'),
    confirmed: () => trace.push('confirmed'),
    released: () => trace.push('released'),
    ...overrides,
  });
  const insert = async (message = input()) => {
    assert.ok(live.insert);
    await live.insert(message);
  };
  const fireTimer = () => {
    assert.equal(timers.size, 1);
    for (const [handle, { callback }] of timers) {
      timers.delete(handle);
      callback();
    }
  };
  return {
    turn,
    sdk,
    live,
    state,
    trace,
    timers,
    runningTools,
    movableAgents,
    movableBash,
    cancellation,
    input,
    insert,
    fireTimer,
  };
}

function inputError(code: string, message: string) {
  return (error: unknown) =>
    error instanceof AppError &&
    error.status === 409 &&
    error.code === code &&
    error.message === message;
}

test('input stream wakes a waiting reader, keeps FIFO under backpressure, and ends after queued input', async () => {
  const queue = new InputQueue();
  const reader = queue[Symbol.asyncIterator]();
  let yielded = false;
  const first = reader.next().then((value) => {
    yielded = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(yielded, false);
  const images: AttachmentImages = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
  ];
  queue.push('initial prompt', images, initialId);
  assert.deepEqual(await first, {
    done: false,
    value: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'initial prompt' }, ...images] },
      parent_tool_use_id: null,
      uuid: initialId,
    },
  });

  queue.push('ordinary follow-up', [], nextId, 'next');
  queue.push('urgent follow-up', [], laterId, 'now');
  queue.end();
  for (const [text, uuid, priority] of [
    ['ordinary follow-up', nextId, 'next'],
    ['urgent follow-up', laterId, 'now'],
  ]) {
    assert.deepEqual(await reader.next(), {
      done: false,
      value: {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        uuid,
        priority,
        origin: { kind: 'human' },
        client_composed: true,
      },
    });
  }
  assert.deepEqual(await reader.next(), { done: true, value: undefined });
});

test('ending an empty input stream wakes a reader and an initial prompt uses no steering fields', async () => {
  const { turn } = fixture();
  const reader = turn.input[Symbol.asyncIterator]();
  const first = reader.next();
  turn.enqueueInitialPrompt('initial prompt', [], initialId);
  assert.deepEqual(await first, {
    done: false,
    value: {
      type: 'user',
      message: { role: 'user', content: 'initial prompt' },
      parent_tool_use_id: null,
      uuid: initialId,
    },
  });
  const ending = reader.next();
  turn.dispose();
  assert.deepEqual(await ending, { done: true, value: undefined });
});

test('eligibility respects tool boundaries, local work, tool ownership, and the occupied slot', async () => {
  const f = fixture();
  const { turn, state, runningTools, movableAgents, input } = f;
  assert.equal(turn.canInsertNext(), false);
  assert.equal(turn.canInsertNow(), true);
  turn.onToolBoundary();
  turn.sendInsertion();
  assert.deepEqual(f.trace, ['checkpoint']);
  assert.equal(turn.canInsertNext(), true);

  state.localWork = true;
  assert.equal(turn.canInsertNext(), false);
  assert.equal(turn.canInsertNow(), false);
  state.localWork = false;
  runningTools.set('agent', { useId: 'foreground' });
  assert.equal(turn.canInsertNext(), false);
  assert.equal(turn.canInsertNow(), false);
  movableAgents.add('agent');
  assert.equal(turn.canInsertNow(), true);
  runningTools.set('child-tool', { useId: 'foreground', subagentId: 'agent' });
  assert.equal(turn.canInsertNow(), false);
  runningTools.delete('agent');
  assert.equal(turn.canInsertNext(), true);
  await f.insert(input({ priority: 'next' }));
  assert.equal(turn.hasLiveInputSlot(), false);
  assert.equal(turn.canInsertNext(), false);
  assert.equal(turn.canInsertNow(), true);
  turn.dispose();
});

test('an urgent insert holds the slot and moves foreground Agent and Bash before publishing input', async () => {
  const f = fixture();
  const { turn, sdk, runningTools, movableAgents, movableBash, trace } = f;
  runningTools.set('agent', { useId: 'agent-use' });
  runningTools.set('shell', { useId: 'bash-use' });
  movableAgents.add('agent');
  movableBash.add('shell');
  const sdkBackground = sdk.backgroundTasks;
  let releaseHandoff: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseHandoff = resolve;
  });
  sdk.backgroundTasks = async (useId) => {
    if (useId === 'agent-use') await held;
    return sdkBackground(useId);
  };
  const insertion = f.insert();
  turn.sendInsertion();
  turn.acknowledgeInsertion(sessionId, [nextId], 'replay');
  assert.deepEqual(trace, []);
  await assert.rejects(
    f.insert(f.input({ id: laterId })),
    inputError('LIVE_INPUT_BUSY', '上一条补充消息还在处理，请稍后再插入。'),
  );
  assert.ok(releaseHandoff);
  releaseHandoff();
  await insertion;
  assert.deepEqual(trace, [
    'background:agent-use',
    'agent:agent',
    'background:bash-use',
    'bash:shell',
    'dispatched',
    `persist:${nextId}`,
    `publish:${nextId}`,
  ]);
  const reader = turn.input[Symbol.asyncIterator]();
  const { value } = await reader.next();
  assert.equal(value?.uuid, nextId);
  assert.equal(value?.priority, 'now');
  turn.dispose();
  assert.equal((await reader.next()).done, true);
});

test('immediate insertion refuses unavailable work or an invalid claim before any handoff', async () => {
  const f = fixture();
  f.runningTools.set('agent', { useId: 'agent-use' });
  await assert.rejects(
    f.insert(),
    inputError('LIVE_INPUT_UNAVAILABLE', '当前步骤需要先停止本轮。'),
  );
  assert.equal(f.turn.hasLiveInputSlot(), true);

  f.movableAgents.add('agent');
  await assert.rejects(
    f.insert(f.input({ canDispatch: () => false })),
    inputError('QUEUE_CHANGED', '队列或执行范围已变化。'),
  );
  assert.equal(f.turn.hasLiveInputSlot(), true);
  assert.deepEqual(f.trace, []);
  f.turn.dispose();
});

test('an immediate insertion rechecks each foreground tool after an earlier handoff', async () => {
  const f = fixture();
  f.runningTools.set('agent', { useId: 'agent-use' });
  f.runningTools.set('shell', { useId: 'bash-use' });
  f.movableAgents.add('agent');
  f.movableBash.add('shell');
  const sdkBackground = f.sdk.backgroundTasks;
  f.sdk.backgroundTasks = async (useId) => {
    f.movableBash.delete('shell');
    return sdkBackground(useId);
  };
  await assert.rejects(f.insert(), inputError('LIVE_INPUT_UNAVAILABLE', '当前运行无法插入消息。'));
  assert.equal(f.turn.hasLiveInputSlot(), true);
  assert.deepEqual(f.trace, ['background:agent-use', 'agent:agent']);
  f.turn.dispose();
});

test('a deferred claim changed before dispatch is released without persistence', async () => {
  const f = fixture();
  f.state.localWork = true;
  await f.insert(f.input({ priority: 'next', canDispatch: () => false }));
  assert.equal(f.turn.hasLiveInputSlot(), false);
  assert.deepEqual(f.trace, []);
  f.state.localWork = false;
  f.turn.sendInsertion();
  assert.equal(f.turn.hasLiveInputSlot(), true);
  assert.deepEqual(f.trace, ['released']);
  f.turn.dispose();
});

for (const receipt of ['reply', 'replay'] as const)
  test(`a matching ${receipt} confirms once and waits for the matching result`, async () => {
    const f = fixture();
    const { turn, trace } = f;
    await f.insert();
    trace.length = 0;
    const ids = sdkInputIds({
      user_message_uuid: laterId,
      user_message_uuids: [initialId, nextId],
    });
    turn.acknowledgeInsertion('other-session', ids, receipt);
    turn.acknowledgeInsertion(sessionId, [initialId], receipt);
    assert.equal(trace.length, 0);
    assert.equal(turn.unsettledInputFailure(), '补充消息未收到 SDK 回执。');
    turn.acknowledgeInsertion(sessionId, ids, receipt);
    turn.acknowledgeInsertion(sessionId, ids, receipt);
    assert.deepEqual(trace, [
      'confirmed',
      `transcript:${nextId}`,
      `sdk.input_confirmed:${nextId}:${receipt}`,
    ]);
    assert.equal(turn.hasLiveInputSlot(), true);
    assert.equal(turn.hasUnsettledInput(), true);
    assert.equal(turn.unsettledInputFailure(), 'SDK 连接已结束，但未返回补充消息的终态。');
    assert.equal(turn.onFinalResult(result(initialId)), true);
    assert.equal(turn.onFinalResult({ ...result(nextId), session_id: 'other-session' }), true);
    assert.equal(
      turn.onFinalResult({ ...result(), user_message_uuids: undefined, user_message_uuid: nextId }),
      false,
    );
    turn.dispose();
    assert.ok(!trace.includes('released'));
  });

test('a successful result can confirm and settle an input with no earlier receipt', async () => {
  const f = fixture();
  await f.insert();
  assert.equal(f.turn.onFinalResult({ ...result(nextId), is_error: true }), true);
  assert.equal(f.turn.hasLiveInputSlot(), false);
  assert.equal(f.turn.onFinalResult(result(nextId)), false);
  assert.deepEqual(f.trace.slice(-3), [
    'confirmed',
    `transcript:${nextId}`,
    `sdk.input_confirmed:${nextId}:result`,
  ]);
  f.turn.dispose();
});

test('native settlement waits 120 seconds after idle and cancels on running or a matching receipt', async () => {
  const f = fixture();
  const { turn, live, timers, sdk } = f;
  await f.insert();
  const reader = turn.input[Symbol.asyncIterator]();
  assert.equal((await reader.next()).value?.uuid, nextId);
  const ending = reader.next();
  assert.equal(turn.onFinalResult(result(initialId)), true);
  assert.equal(turn.afterResultRecorded(flush), 'continue');
  turn.onSessionStateChanged('other-session', 'idle');
  assert.equal(timers.size, 0);
  assert.ok(live.insert);

  turn.onSessionStateChanged(sessionId, 'idle');
  turn.onSessionStateChanged(sessionId, 'idle');
  assert.deepEqual(
    [...timers.values()].map(({ delay }) => delay),
    [120_000],
  );
  turn.onSessionStateChanged(sessionId, 'running');
  assert.equal(timers.size, 0);
  turn.onSessionStateChanged(sessionId, 'idle');
  turn.acknowledgeInsertion(sessionId, [initialId], 'reply');
  assert.equal(timers.size, 1);
  turn.acknowledgeInsertion(sessionId, [nextId], 'reply');
  assert.equal(timers.size, 0);
  assert.ok(live.insert);

  turn.onSessionStateChanged(sessionId, 'idle');
  f.fireTimer();
  assert.equal(turn.isDrainingInput, true);
  assert.equal(live.insert, undefined);
  assert.equal(turn.onInitialized(sdk), false);
  assert.equal(live.insert, undefined);
  assert.equal((await ending).done, true);
  turn.dispose();
});

test('dispatching the next native input clears the previous idle timer and requires fresh idle', async () => {
  const f = fixture();
  const { turn, timers, live } = f;
  await f.insert();
  turn.acknowledgeInsertion(sessionId, [nextId], 'replay');
  turn.onFinalResult(result(initialId));
  turn.onSessionStateChanged(sessionId, 'idle');
  assert.equal(timers.size, 1);

  await f.insert(f.input({ id: laterId }));
  assert.equal(timers.size, 0);
  turn.onFinalResult(result(nextId));
  assert.equal(turn.afterResultRecorded(flush), 'continue');
  assert.equal(timers.size, 0);
  turn.onSessionStateChanged(sessionId, 'idle');

  f.runningTools.set('foreground', { useId: 'foreground-use' });
  f.fireTimer();
  assert.ok(live.insert);
  f.runningTools.delete('foreground');
  turn.onSessionStateChanged(sessionId, 'idle');
  f.fireTimer();
  assert.equal(live.insert, undefined);
  turn.dispose();
});

for (const pendingInput of [false, true])
  test(`deferred Bash and Agent keep native input open until both finish (${pendingInput ? 'unsettled input' : 'settled input'})`, async () => {
    const f = fixture(true, 15);
    const { turn, state, timers, live } = f;
    if (pendingInput) await f.insert();
    state.deferredBash = true;
    state.deferredAgents = true;
    state.activeAgents = true;
    turn.onFinalResult(result(initialId));
    const flushed: string[] = [];
    assert.equal(
      turn.afterResultRecorded(() => flushed.push('flush')),
      'continue',
    );
    assert.deepEqual(flushed, pendingInput ? [] : ['flush']);
    turn.onSessionStateChanged(sessionId, 'idle');
    assert.ok(live.insert);
    assert.equal(timers.size, 0);

    state.deferredBash = false;
    turn.afterDeferredWork();
    assert.ok(live.insert);
    assert.equal(timers.size, 0);
    state.deferredAgents = false;
    turn.afterDeferredWork();
    assert.ok(live.insert);
    assert.equal(timers.size, 0);
    state.activeAgents = false;
    turn.afterDeferredWork();
    if (pendingInput) {
      assert.ok(live.insert);
      assert.deepEqual(
        [...timers.values()].map(({ delay }) => delay),
        [15],
      );
      f.fireTimer();
    }
    assert.equal(turn.isDrainingInput, true);
    assert.equal(live.insert, undefined);
    turn.dispose();
  });

test('controlled mode uses its model state when an acknowledged input is still awaiting a result', async () => {
  const f = fixture(false);
  const { turn, timers, live } = f;
  await f.insert();
  turn.acknowledgeInsertion(sessionId, [nextId], 'reply');
  turn.onFinalResult(result(initialId));
  assert.equal(turn.afterResultRecorded(flush), 'continue');
  assert.equal(timers.size, 1);
  turn.onSessionStateChanged(sessionId, 'running');
  assert.equal(timers.size, 1);
  turn.onModelStarted();
  f.fireTimer();
  assert.ok(live.insert);

  turn.onFinalResult(result(initialId));
  turn.afterResultRecorded(flush);
  f.fireTimer();
  assert.equal(live.insert, undefined);
  turn.dispose();
});

test('controlled deferred work drains settled input only after the model returns', () => {
  const f = fixture(false);
  f.state.deferredAgents = true;
  f.turn.onFinalResult(result(initialId));
  f.turn.onModelStarted();
  f.state.deferredAgents = false;
  f.turn.afterDeferredWork();
  assert.ok(f.live.insert);
  f.turn.onFinalResult(result(initialId));
  f.turn.afterDeferredWork();
  assert.equal(f.live.insert, undefined);
  f.turn.dispose();
});

test('closing disables live input, rejects late receipts after abort, and releases unconfirmed input once', async () => {
  const f = fixture();
  const { turn, cancellation, timers, trace, live, sdk } = f;
  await f.insert();
  turn.onFinalResult(result(initialId));
  turn.onSessionStateChanged(sessionId, 'idle');
  assert.equal(timers.size, 1);
  turn.onClosing();
  assert.equal(live.insert, undefined);
  assert.equal(turn.onInitialized(sdk), false);
  assert.equal(live.insert, undefined);
  cancellation.abort();
  turn.acknowledgeInsertion(sessionId, [nextId], 'reply');
  assert.equal(turn.unsettledInputFailure(), undefined);
  turn.releaseUnconfirmedInput();
  turn.dispose();
  assert.equal(timers.size, 0);
  assert.deepEqual(trace, ['dispatched', `persist:${nextId}`, `publish:${nextId}`, 'released']);
  const reader = turn.input[Symbol.asyncIterator]();
  assert.equal((await reader.next()).value?.uuid, nextId);
  assert.equal((await reader.next()).done, true);
});
