/**
 * @file 验证对话轮次归并和历史渲染隔离。
 * @implementation 使用纯内存合成快照覆盖混排、占位、运行数据归属和流式更新。
 * @updated 2026-11-27T19:30:00+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Subagent } from '@shared/subagents';
import type {
  Artifact,
  Attachment,
  Message,
  Permission,
  Run,
  RunEvent,
  ToolCall,
} from '@shared/types';
import {
  areLegacyTurnPropsEqual,
  areOrderedTurnPropsEqual,
  buildConversationTurns,
  type TurnState,
} from './conversation-turns';

const at = '2026-11-27T00:00:00.000Z';
const sessionId = 'session';
const projectId = 'project';

function run(id: string, ordered = false, extra?: Partial<Run>): Run {
  return {
    id,
    sessionId,
    projectId,
    prompt: '',
    status: 'completed',
    mode: 'readonly',
    createdAt: at,
    startedAt: at,
    endedAt: at,
    reason: null,
    error: null,
    retryOf: null,
    contextPaths: [],
    attachmentIds: [],
    plan: [],
    usage: null,
    config: { gateway: 'http://fixture.test', model: 'fixture', maxTurns: 1, timeoutMs: 1000 },
    transcript: ordered ? { version: 1, notices: [] } : undefined,
    ...extra,
  };
}

function message(runId: string, id: string, role: Message['role'], text = 'text'): Message {
  return { id, runId, sessionId, role, text, createdAt: at };
}

function records(runId: string, id: number) {
  const attachment: Attachment = {
    id: `file-${id}`,
    sessionId,
    name: 'file',
    mime: 'text/plain',
    status: 'used',
    size: 1,
    createdAt: at,
  };
  const tool: ToolCall = {
    id: `tool-${id}`,
    runId,
    sessionId,
    name: 'Read',
    inputSummary: '',
    status: 'running',
    output: '',
    startedAt: at,
    endedAt: null,
  };
  const event: RunEvent = {
    id,
    seq: id,
    runId,
    sessionId,
    type: 'sdk.context_restarted',
    at,
    payload: {},
  };
  const artifact: Artifact = {
    id: `artifact-${id}`,
    runId,
    sessionId,
    projectId,
    name: 'result',
    mime: 'text/plain',
    size: 1,
    fingerprint: 'fingerprint',
    availability: 'available',
    createdAt: at,
  };
  const permission: Permission = {
    id: `permission-${id}`,
    runId,
    sessionId,
    toolCallId: tool.id,
    kind: 'command',
    path: null,
    command: null,
    before: null,
    after: null,
    diff: '',
    baseFingerprint: null,
    version: '1',
    status: 'pending',
    createdAt: at,
    expiresAt: at,
    reason: '',
  };
  const subagent: Subagent = {
    id: `agent-${id}`,
    runId,
    sessionId,
    kind: 'worker',
    title: 'worker',
    status: 'running',
    summary: null,
    startedAt: at,
    endedAt: null,
  };
  return { attachment, tool, event, artifact, permission, subagent };
}

type Input = Parameters<typeof buildConversationTurns>[0];
const empty: Input = {
  runs: [],
  messages: [],
  tools: [],
  events: [],
  artifacts: [],
  permissions: [],
  attachments: [],
};

test('mixed history keeps first ordered position, first-user placeholder placement and legacy ownership', () => {
  const turns = buildConversationTurns({
    ...empty,
    runs: [run('missing'), run('ordered', true), run('legacy'), run('no-user')],
    messages: [
      message('missing', 'missing-user', 'user'),
      message('ordered', 'ordered-user', 'user'),
      message('legacy', 'legacy-user', 'user'),
      message('ordered', 'ordered-text', 'assistant'),
      message('missing', 'missing-insertion', 'user'),
      message('legacy', 'legacy-text', 'assistant'),
      message('legacy', 'legacy-whitespace', 'assistant', '  \n'),
    ],
  });
  assert.deepEqual(
    turns.map((turn) =>
      turn.kind === 'ordered'
        ? [turn.kind, turn.slice.run.id, turn.hasGlobalLastMessage, turn.lastRealMessageId]
        : [turn.kind, turn.message.id, turn.isFooterOwner, turn.isLastMessage, turn.hasSubsequent],
    ),
    [
      ['legacy', 'missing-user', false, false, true],
      ['legacy', 'run-reply:missing', true, false, false],
      ['ordered', 'ordered', false, undefined],
      ['legacy', 'legacy-user', false, false, true],
      ['legacy', 'missing-insertion', false, false, true],
      ['legacy', 'legacy-text', false, false, true],
      ['legacy', 'legacy-whitespace', true, false, false],
      ['legacy', 'run-reply:no-user', true, true, false],
    ],
  );
  assert.deepEqual(
    turns.map((turn) => turn.slice.hasAssistantText),
    [false, false, true, true, false, true, true, false],
  );
});

test('run slices preserve references and attachment positions without leaking across runs', () => {
  const one = records('one', 1);
  const two = records('two', 2);
  const orderedUser = message('one', 'one-user', 'user');
  const legacyUser = message('two', 'two-user', 'user');
  const [ordered, legacy] = buildConversationTurns({
    ...empty,
    runs: [
      run('one', true, { attachmentIds: [one.attachment.id, 'missing'] }),
      run('two', false, { attachmentIds: [two.attachment.id] }),
    ],
    messages: [orderedUser, legacyUser],
    tools: [two.tool, one.tool],
    events: [one.event],
    artifacts: [one.artifact, two.artifact],
    permissions: [one.permission, two.permission],
    subagents: [two.subagent, one.subagent],
    attachments: [two.attachment, one.attachment],
  });
  assert.ok(ordered?.kind === 'ordered' && legacy?.kind === 'legacy');
  for (const [turn, entry, original, attachments] of [
    [ordered, one, orderedUser, [one.attachment, undefined]],
    [legacy, two, legacyUser, [two.attachment]],
  ] as const) {
    assert.strictEqual(turn.slice.messages[0], original);
    assert.equal(turn.slice.messages.length, 1);
    assert.deepEqual(turn.slice.attachments, attachments);
    assert.strictEqual(turn.slice.attachments[0], entry.attachment);
    assert.deepEqual(turn.slice.tools, [entry.tool]);
    assert.strictEqual(turn.slice.tools[0], entry.tool);
    assert.deepEqual(turn.slice.artifacts, [entry.artifact]);
    assert.deepEqual(turn.slice.permissions, [entry.permission]);
    assert.deepEqual(turn.slice.subagents, [entry.subagent]);
    assert.equal(turn.slice.hasAssistantText, false);
  }
  assert.deepEqual(ordered.slice.events, [one.event]);
  assert.equal(ordered.slice.contextRestarted, true);
  assert.deepEqual(legacy.slice.events, []);
  assert.equal(legacy.slice.contextRestarted, false);
});

const noop = () => {};
const state: TurnState = {
  sessionId,
  hasFork: false,
  submitting: false,
  archived: false,
  isComposerPlanOwner: false,
  stopPending: false,
  retryDisabled: false,
  actions: { onPermission: noop, onOutput: noop, onTrace: noop, onRetry: noop },
  messageTime: { full: new Intl.DateTimeFormat('en'), short: new Intl.DateTimeFormat('en') },
};

for (const activeOrdered of [true, false]) {
  test(`streaming updates invalidate only the affected ${activeOrdered ? 'ordered' : 'legacy'} rows`, () => {
    const history = run('history', true);
    const old = run('old');
    const active = run('active', activeOrdered, { status: 'running' });
    const activeUser = message(active.id, 'active-user', 'user');
    const historyText = message(history.id, 'history-text', 'assistant');
    const historyRecords = records(history.id, 1);
    const oldUser = message(old.id, 'old-user', 'user');
    const oldRecords = records(old.id, 2);
    const snapshot: Input = {
      ...empty,
      runs: [history, old, active],
      messages: [historyText, oldUser, activeUser],
      tools: [historyRecords.tool, oldRecords.tool],
      events: [oldRecords.event, historyRecords.event],
    };
    const activeText = message(active.id, 'active-text', 'assistant');
    const activeTool = records(active.id, 3).tool;
    const added: Input = {
      ...snapshot,
      messages: [...snapshot.messages, activeText],
      tools: [...snapshot.tools, activeTool],
    };
    const textUpdated: Input = {
      ...added,
      messages: [...snapshot.messages, { ...activeText, text: 'additional tokens' }],
    };
    const toolUpdated: Input = {
      ...textUpdated,
      tools: [...snapshot.tools, { ...activeTool, output: 'finished reading' }],
    };
    for (const [before, after] of [
      [snapshot, added],
      [added, textUpdated],
      [textUpdated, toolUpdated],
    ] as const) {
      const previous = buildConversationTurns(before);
      const next = buildConversationTurns(after);
      const historyBefore = previous[0];
      const historyAfter = next[0];
      assert.ok(historyBefore?.kind === 'ordered' && historyAfter?.kind === 'ordered');
      assert.notStrictEqual(historyBefore.slice.tools, historyAfter.slice.tools);
      assert.ok(
        areOrderedTurnPropsEqual(
          { ...state, turn: historyBefore },
          { ...state, turn: historyAfter },
        ),
      );
      for (const index of [1, 2]) {
        const oldBefore = previous[index];
        const oldAfter = next[index];
        assert.ok(oldBefore?.kind === 'legacy' && oldAfter?.kind === 'legacy');
        assert.ok(
          areLegacyTurnPropsEqual({ ...state, turn: oldBefore }, { ...state, turn: oldAfter }),
        );
      }

      const activeBefore = previous.at(-1);
      const activeAfter = next.at(-1);
      if (activeOrdered) {
        assert.ok(activeBefore?.kind === 'ordered' && activeAfter?.kind === 'ordered');
        assert.ok(activeAfter.hasGlobalLastMessage);
        assert.equal(activeAfter.lastRealMessageId, activeText.id);
        assert.equal(
          areOrderedTurnPropsEqual(
            { ...state, turn: activeBefore },
            { ...state, turn: activeAfter },
          ),
          false,
        );
      } else {
        assert.ok(activeBefore?.kind === 'legacy' && activeAfter?.kind === 'legacy');
        assert.ok(activeAfter.isFooterOwner && activeAfter.isLastMessage);
        assert.equal(
          areLegacyTurnPropsEqual(
            { ...state, turn: activeBefore },
            { ...state, turn: activeAfter },
          ),
          false,
        );
      }
    }
  });
}

test('appending a run changes only the former head markers or other props used by history', () => {
  const historical = run('historical', true);
  const head = message(historical.id, 'head', 'assistant');
  const old = { ...empty, runs: [historical], messages: [head] };
  const [before] = buildConversationTurns(old);
  const [after, placeholder] = buildConversationTurns({
    ...old,
    runs: [...old.runs, run('empty')],
  });
  assert.ok(
    before?.kind === 'ordered' && after?.kind === 'ordered' && placeholder?.kind === 'legacy',
  );
  assert.equal(before.hasGlobalLastMessage, true);
  assert.equal(after.hasGlobalLastMessage, false);
  assert.equal(after.lastRealMessageId, head.id);
  assert.equal(placeholder.hasSubsequent, false);
  assert.ok(
    areOrderedTurnPropsEqual(
      { ...state, turn: before },
      { ...state, turn: before, actions: { ...state.actions } },
    ),
  );
  const [withNewHead] = buildConversationTurns({
    ...old,
    runs: [...old.runs, run('new')],
    messages: [...old.messages, message('new', 'new-head', 'user')],
  });
  assert.ok(withNewHead?.kind === 'ordered');
  assert.equal(withNewHead.lastRealMessageId, undefined);
  assert.equal(
    areOrderedTurnPropsEqual({ ...state, turn: before }, { ...state, turn: after }),
    false,
  );
  assert.equal(
    areOrderedTurnPropsEqual(
      { ...state, turn: before },
      { ...state, turn: before, actions: { ...state.actions, onTrace: () => {} } },
    ),
    false,
  );
});
