/**
 * @file 验证运行转录的顺位、刷盘和收尾。
 * @implementation 用内存宿主记录事务和事件，使用类型化 SDK 帧及假定时器覆盖两种工具到达顺序。
 * @updated 2026-11-27T18:02:17+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  RunTranscriptLedger,
  type RunTranscriptLedgerHost,
} from '../server/modules/runs/run-transcript-ledger.js';
import {
  finalizeRunTranscript,
  type RunTranscript,
  type TranscriptNotice,
} from '../shared/ordered-transcript.js';
import type { Message, ToolCall } from '../shared/types.js';

const initialTime = '2026-11-27T10:00:00.000Z';
const laterTime = '2026-11-27T10:00:01.000Z';
const sdkId = '00000000-0000-4000-8000-000000000000';
const appToolId = (id: string) => `run:${id}`;
const prompt = 'prompt';
const reply = 'reply';

function fixture(options?: ConstructorParameters<typeof RunTranscriptLedger>[1]) {
  const trace: string[] = [];
  const saved: RunTranscript[] = [];
  const messages = new Map<string, Message>();
  const tools = new Map<string, ToolCall>();
  let at = initialTime;
  const host: RunTranscriptLedgerHost = {
    transaction(write) {
      trace.push('begin');
      write();
      trace.push('commit');
    },
    saveTranscript(state) {
      trace.push('save transcript');
      saved.push(structuredClone(state));
    },
    updateMessage(id, changes) {
      trace.push(`update ${id}`);
      const message = messages.get(id);
      assert.ok(message);
      messages.set(id, { ...message, ...changes });
    },
    insertTool(tool) {
      trace.push(`insert ${tool.id}`);
      tools.set(tool.id, tool);
    },
    updateToolPosition(id, orders) {
      trace.push(`position ${id}`);
      const tool = tools.get(id);
      assert.ok(tool);
      tools.set(id, { ...tool, ...orders });
    },
    emitMessageDelta: (id) => trace.push(`message.delta ${id}`),
    emitToolAnnounced: (id, name) => trace.push(`tool.announced ${id} ${name}`),
    now: () => at,
  };
  const ledger = new RunTranscriptLedger(host, options);
  function putMessage(id: string, role: Message['role'], transcriptOrder?: number) {
    trace.push(`insert ${id}`);
    messages.set(id, {
      id,
      runId: 'run',
      sessionId: 'session',
      role,
      text: '',
      createdAt: at,
      transcriptOrder,
    });
    return id;
  }
  putMessage(prompt, 'user');
  trace.length = 0;
  assert.equal(
    ledger.initialize(prompt, () => putMessage(reply, 'assistant')),
    reply,
  );
  const createTool = (nativeId: string, topLevel = true) => {
    const id = appToolId(nativeId);
    return ledger.createTool(id, topLevel, (orders) => ({
      id,
      runId: 'run',
      sessionId: 'session',
      name: 'Read',
      ...orders,
      inputSummary: '{}',
      status: 'running',
      output: '',
      startedAt: at,
      endedAt: null,
    }));
  };
  const stream = (event: SDKPartialAssistantMessage['event'], assistantId = reply) =>
    ledger.acceptStream(
      { type: 'stream_event', uuid: sdkId, session_id: sdkId, parent_tool_use_id: null, event },
      assistantId,
      appToolId,
    );
  return {
    ledger,
    trace,
    saved,
    messages,
    tools,
    host,
    putMessage,
    createTool,
    setTime: (value: string) => {
      at = value;
    },
    transcript: () => saved.at(-1),
    stream,
    observeTool: (id: string) =>
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id, name: 'Read', input: {} },
      }),
  };
}

function modelMessage(
  id: string,
  content: SDKAssistantMessage['message']['content'] = [],
): SDKAssistantMessage['message'] {
  return {
    id,
    role: 'assistant',
    type: 'message',
    model: 'fixture-model',
    content,
    container: null,
    context_management: null,
    diagnostics: null,
    stop_details: null,
    stop_reason: null,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: 0,
      iterations: null,
      output_tokens: 0,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

test('initializes version 1 and the first user order before binding the assistant placeholder', () => {
  const f = fixture();
  assert.deepEqual(f.transcript(), { version: 1, notices: [], pendingDenials: undefined });
  assert.equal(f.messages.get(prompt)?.transcriptOrder, 1);
  assert.deepEqual(f.trace, [
    'begin',
    'save transcript',
    'update prompt',
    'commit',
    'insert reply',
  ]);

  f.stream({ type: 'message_start', message: modelMessage('first') }, 'unrelated');
  f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } });
  f.ledger.flush();
  assert.equal(f.messages.get(reply)?.text, 'first');
  assert.equal(f.messages.get(reply)?.transcriptParts?.[0]?.order, 2);
});

test('uses an 80 ms timer and flushes multiple dirty replies in one transaction', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  f.ledger.startFlushing();
  t.after(() => f.ledger.dispose());
  f.ledger.fallback(reply, 'first');
  assert.equal(f.messages.get(reply)?.text, '');
  const next = f.ledger.recordUserInput('next', (order) => {
    assert.equal(f.messages.get(reply)?.text, 'first');
    f.putMessage('next', 'user', order);
    return f.putMessage('reply-next', 'assistant');
  });
  assert.equal(f.messages.get('next')?.transcriptOrder, 3);
  f.trace.length = 0;
  f.stream({ type: 'message_start', message: modelMessage('late') }, next);
  f.stream(
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'late' } },
    next,
  );
  f.ledger.acknowledgeInput('next');
  f.stream({ type: 'message_start', message: modelMessage('new') }, reply);
  f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'new' } });
  t.mock.timers.tick(79);
  assert.deepEqual(f.trace, []);
  t.mock.timers.tick(1);
  assert.deepEqual(f.trace, [
    'begin',
    'update reply',
    'message.delta reply',
    'update reply-next',
    'message.delta reply-next',
    'commit',
  ]);
  assert.equal(f.messages.get(reply)?.text, 'first\n\nlate');
  assert.equal(f.messages.get(next)?.text, 'new');
  assert.deepEqual(
    f.messages.get(next)?.transcriptParts?.map(({ start, end }) => [start, end]),
    [[0, 3]],
  );

  f.trace.length = 0;
  f.stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: ' reply' },
  });
  f.ledger.flush();
  t.mock.timers.tick(80);
  assert.deepEqual(f.trace, ['begin', 'update reply-next', 'message.delta reply-next', 'commit']);
  assert.equal(f.messages.get(next)?.text, 'new reply');
});

test('an observed SDK tool announces preparation and creation adopts its order atomically', () => {
  const f = fixture();
  const id = appToolId('first');
  f.trace.length = 0;
  f.ledger.fallback(reply, 'before the tool');
  f.observeTool('first');
  const position = f.ledger.toolPosition(id);
  assert.deepEqual(f.transcript()?.notices, [
    { kind: 'tool_preparing', toolCallId: id, toolName: 'Read', order: 3, at: position?.at },
  ]);
  assert.deepEqual(f.trace, [
    'begin',
    'update reply',
    'message.delta reply',
    'commit',
    'begin',
    `tool.announced ${id} Read`,
    'save transcript',
    'commit',
  ]);
  assert.equal(f.ledger.hasSeenTool(id), false);

  f.trace.length = 0;
  const tool = f.createTool('first');
  assert.equal(tool.transcriptOrder, 3);
  assert.equal(tool.transcriptHookOrder, undefined);
  assert.equal(f.ledger.hasSeenTool(id), true);
  assert.deepEqual(f.transcript()?.notices, []);
  assert.deepEqual(f.trace, ['begin', `insert ${id}`, 'save transcript', 'commit']);
  f.ledger.recordBlockedTool(id, 'Read');
  assert.equal(f.saved.length, 3);
});

test('a tool created by a hook takes the position of the later assistant receipt', () => {
  const f = fixture();
  const id = appToolId('early');
  const tool = f.createTool('early');
  assert.equal(tool.transcriptHookOrder, 2);
  assert.equal(tool.transcriptOrder, undefined);
  const subagent = f.createTool('branch', false);
  assert.equal(subagent.transcriptHookOrder, undefined);
  assert.equal(subagent.transcriptOrder, undefined);

  f.trace.length = 0;
  const receipt: SDKAssistantMessage = {
    type: 'assistant',
    uuid: sdkId,
    session_id: sdkId,
    parent_tool_use_id: null,
    message: modelMessage('receipt', [{ type: 'tool_use', id: 'early', name: 'Read', input: {} }]),
  };
  assert.equal(f.ledger.acceptAssistant(receipt, reply, appToolId), reply);
  assert.equal(f.tools.get(id)?.transcriptOrder, 3);
  assert.equal(f.tools.get(id)?.transcriptHookOrder, undefined);
  assert.deepEqual(f.transcript()?.notices, []);
  assert.deepEqual(f.trace, [
    'begin',
    `position ${id}`,
    `tool.announced ${id} Read`,
    'save transcript',
    'commit',
  ]);
  f.observeTool('early');
  assert.equal(f.saved.length, 2);
});

test('blocks before or after observing a tool, preserving denial time and deduplicating', () => {
  const f = fixture();
  const id = appToolId('denied');
  f.ledger.recordBlockedTool(id, 'Read');
  const denial = {
    kind: 'tool_blocked',
    toolCallId: id,
    toolName: 'Read',
    order: 2,
    at: initialTime,
  };
  assert.deepEqual(f.transcript()?.pendingDenials, [denial]);
  f.setTime(laterTime);
  f.ledger.recordBlockedTool(id, 'Duplicate');
  assert.equal(f.saved.length, 2);
  f.observeTool('denied');
  assert.deepEqual(f.transcript()?.notices, [{ ...denial, order: 3 }]);
  assert.equal(f.transcript()?.pendingDenials, undefined);
  f.ledger.recordBlockedTool(id, 'Duplicate');
  assert.equal(f.saved.length, 3);

  f.observeTool('late-denial');
  f.ledger.recordBlockedTool(appToolId('late-denial'), 'Read');
  assert.deepEqual(f.transcript()?.notices?.at(-1), {
    ...denial,
    toolCallId: appToolId('late-denial'),
    order: 4,
    at: laterTime,
  });

  const recovered = appToolId('actual-hook');
  f.ledger.recordBlockedTool(recovered, 'Read');
  f.trace.length = 0;
  f.createTool('actual-hook');
  assert.equal(f.transcript()?.pendingDenials, undefined);
  assert.deepEqual(f.trace, ['begin', `insert ${recovered}`, 'save transcript', 'commit']);
});

test('deduplicates notices by key and finalize stops the injected timer before the last flush', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const scheduled = t.mock.fn((flush: () => void, interval: number) =>
    setInterval(flush, interval),
  );
  const canceled = t.mock.fn((timer: ReturnType<typeof setInterval>): void => {
    f.trace.push('stop timer');
    clearInterval(timer);
  });
  const f = fixture({ flushIntervalMs: 25, setInterval: scheduled, clearInterval: canceled });
  f.ledger.startFlushing();
  assert.equal(scheduled.mock.calls[0]?.arguments[1], 25);
  const notice = t.mock.fn(
    (position: Pick<TranscriptNotice, 'at' | 'order'>): TranscriptNotice => ({
      ...position,
      kind: 'api_error',
      code: 'overloaded',
    }),
  );
  f.observeTool('never-started');
  f.ledger.recordBlockedTool(appToolId('no-frame'), 'Read');
  f.ledger.fallback(reply, 'before notice');
  f.trace.length = 0;
  f.ledger.recordNotice('receipt', notice);
  f.ledger.recordNotice('receipt', notice);
  assert.equal(notice.mock.callCount(), 1);
  assert.deepEqual(f.trace, [
    'begin',
    'update reply',
    'message.delta reply',
    'commit',
    'save transcript',
  ]);

  const runningState = f.transcript();
  assert.ok(runningState);
  f.stream({ type: 'message_start', message: modelMessage('final') });
  f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'last' } });
  f.trace.length = 0;
  assert.deepEqual(f.ledger.finalize(), finalizeRunTranscript(runningState));
  assert.equal(canceled.mock.callCount(), 1);
  assert.deepEqual(f.trace, [
    'stop timer',
    'begin',
    'update reply',
    'message.delta reply',
    'commit',
  ]);
  assert.equal(f.messages.get(reply)?.text, 'before notice\n\nlast');
  assert.equal(f.messages.get(reply)?.transcriptParts?.at(-1)?.order, 7);

  f.trace.length = 0;
  f.stream({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: ' after exit' },
  });
  t.mock.timers.tick(25);
  assert.deepEqual(f.trace, []);
  f.ledger.dispose();
  assert.equal(canceled.mock.callCount(), 1);
});

test('dispose flushes before cleanup, and finalization promotes lost hook positions in the finishing transaction', () => {
  const f = fixture();
  const id = appToolId('lost');
  f.createTool('lost');
  f.ledger.fallback(reply, 'last');
  f.trace.length = 0;
  f.ledger.dispose();
  assert.equal(f.tools.get(id)?.transcriptHookOrder, 2);
  f.host.transaction(() => f.host.saveTranscript(f.ledger.finalize()));
  assert.equal(f.tools.get(id)?.transcriptOrder, 2);
  assert.equal(f.tools.get(id)?.transcriptHookOrder, undefined);
  assert.deepEqual(f.trace, [
    'begin',
    'update reply',
    'message.delta reply',
    'commit',
    'begin',
    `position ${id}`,
    'save transcript',
    'commit',
  ]);
});
