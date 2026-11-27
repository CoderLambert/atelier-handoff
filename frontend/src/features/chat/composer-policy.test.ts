/**
 * @file 验证输入策略、草稿引用和键盘分派。
 * @implementation 用内存快照、固定引用标识与确定的键盘事件覆盖边界，不访问浏览器和运行时。
 * @updated 2026-11-27T18:34:46+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerTextLimit, messageQuoteLimit, type MessageQuote } from '@shared/message-quotes';
import type { Draft, Extension, RunStatus } from '@shared/types';
import {
  choices,
  chooseExtension,
  selectCompletionKey,
  triggerAt,
} from '../extensions/picker-model';
import {
  appendDraftQuote,
  findActiveRun,
  findInsertableRunId,
  isDirectoryAvailable,
  isNativeAvailable,
  selectComposerPolicy,
} from './composer-policy';
import { dispatchComposerKey, isComposerImeKey, type ComposerKey } from './use-composer-keymap';

const draft: Draft = { text: 'Task', mode: 'edit', contextPaths: [], attachmentIds: [] };
const session = { id: 'session', status: 'active' } as const;
const snapshot = { session, project: { available: true }, runs: [] };
const agent = { mode: 'readonly', capabilities: [] } as const;
const run = (status: RunStatus, id = status) => ({ id, status, sessionId: session.id });

test('composer policy resolves the effective mode and profile capabilities', () => {
  const nativeDraft = { ...draft, executionPreference: 'native-v1' } as const;
  const automaticDraft = { ...draft, approvalMode: 'automatic' } as const;
  assert.equal(isNativeAvailable(snapshot, true), true);
  assert.equal(isNativeAvailable(snapshot, false), false);
  assert.equal(isNativeAvailable({ ...snapshot, agent }, true), false);
  const revision = { ...snapshot, session: { ...session, agentRevisionId: 'revision' } };
  assert.equal(isNativeAvailable(revision, true), false);
  assert.equal(selectComposerPolicy(snapshot, draft, true).mode, 'edit');
  assert.equal(selectComposerPolicy(snapshot, nativeDraft, true).mode, 'native');
  assert.equal(selectComposerPolicy(revision, nativeDraft, true).mode, 'edit');
  assert.equal(selectComposerPolicy(snapshot, automaticDraft, true).mode, 'automatic');
  assert.equal(
    selectComposerPolicy(snapshot, { ...draft, mode: 'readonly' }, true).mode,
    'readonly',
  );

  const readonly = selectComposerPolicy({ ...snapshot, agent }, automaticDraft, true);
  assert.equal(readonly.mode, 'readonly');
  assert.equal(readonly.contextAllowed, false);
  assert.equal(readonly.attachmentsAllowed, false);
  const withContext = selectComposerPolicy(
    { ...snapshot, agent: { mode: 'readonly', capabilities: ['context'] } },
    nativeDraft,
    true,
  );
  assert.equal(withContext.mode, 'readonly');
  assert.equal(withContext.contextAllowed, true);
  assert.equal(withContext.attachmentsAllowed, false);
});

test('the bound directory state takes precedence over project availability', () => {
  assert.equal(isDirectoryAvailable(snapshot), true);
  const unavailable = { ...snapshot, project: { available: false } };
  assert.equal(isDirectoryAvailable(unavailable), false);
  assert.equal(isDirectoryAvailable({ ...unavailable, workspace: { state: 'ready' } }), true);
  for (const state of ['missing', 'busy', 'snapshotted', 'changed'] as const) {
    assert.equal(isDirectoryAvailable({ ...snapshot, workspace: { state } }), false, state);
  }
});

test('readonly completion removes incompatible retained tools without rewriting draft preferences', () => {
  const extension: Extension = {
    id: 'mcp',
    kind: 'mcp',
    projectId: 'project',
    name: 'docs',
    description: '',
    source: 'manual',
    enabled: true,
    version: 1,
    transport: { type: 'http', url: 'https://example.test/mcp' },
    status: 'connected',
    tools: [
      { name: 'read', description: '' },
      { name: 'write', description: '' },
    ],
    allowedTools: [
      { name: 'read', access: 'read' },
      { name: 'write', access: 'approval' },
    ],
  };
  const previous: Draft = {
    ...draft,
    text: '#docs',
    approvalMode: 'automatic',
    executionPreference: 'project-v1',
    extensionSelections: [{ id: 'mcp', version: 1, tools: ['write'] }],
  };
  const token = triggerAt(previous.text, previous.text.length, previous.text.length);
  assert.ok(token);
  const row = choices([extension], token, previous.text, 'readonly')[0];
  assert.ok(row);
  assert.deepEqual(chooseExtension(previous, token, row, 'readonly').draft, {
    ...previous,
    text: '',
    extensionSelections: [{ id: 'mcp', version: 1, tools: ['read'] }],
  });
});

test('composer and queue choose their respective active run and share insertability rules', () => {
  const queued = run('queued');
  const awaiting = run('awaiting_permission');
  const runs = [run('completed'), queued, awaiting, run('running')];
  assert.equal(findActiveRun(runs), queued);
  assert.equal(findActiveRun(runs, { includeQueued: false }), awaiting);
  assert.equal(findActiveRun([queued], { includeQueued: false }), undefined);
  assert.equal(selectComposerPolicy({ ...snapshot, runs }, draft).insertRunId, undefined);
  for (const status of ['running', 'awaiting_permission'] as const) {
    assert.equal(findInsertableRunId(run(status), session.id), status);
    assert.equal(
      selectComposerPolicy({ ...snapshot, runs: [run(status)] }, draft).insertRunId,
      status,
    );
  }
  for (const status of [
    'queued',
    'stopping',
    'completed',
    'stopped',
    'failed',
    'interrupted',
  ] as const) {
    assert.equal(findInsertableRunId(run(status), session.id), undefined, status);
  }
  assert.equal(findInsertableRunId(undefined, session.id), undefined);
  assert.equal(findInsertableRunId(run('running'), 'other-session'), undefined);
  const archived = {
    ...snapshot,
    session: { ...session, status: 'archived' },
    runs: [awaiting],
  } as const;
  assert.equal(selectComposerPolicy(archived, draft).archived, true);
  assert.equal(selectComposerPolicy(archived, draft).insertRunId, undefined);
  const paused = selectComposerPolicy(
    { ...snapshot, messageQueue: { items: [], paused: true } },
    draft,
  );
  assert.equal(paused.queueing, true);
  assert.equal(paused.hasQueuedMessages, false);
});

test('draft quote deduplication preserves the three existing identities and checks duplicates first', () => {
  const full = { id: 'message', text: 'Reply' };
  const excerpt = { id: 'quote:excerpt', sourceMessageId: full.id, text: 'Excerpt' };
  const file = {
    id: 'quote:file',
    text: 'Line',
    file: { path: 'src/file.ts', startLine: 4, endLine: 4, version: 'worktree' },
  } as const;
  const other = { id: 'another', text: 'Another reply' };
  const messageQuotes = [full, excerpt, file, other, { ...other, id: 'other-message' }];
  assert.equal(messageQuotes.length, messageQuoteLimit);
  const last = messageQuotes.at(-1);
  assert.ok(last);
  assert.deepEqual(
    appendDraftQuote({ ...draft, messageQuotes: messageQuotes.slice(0, -1) }, last),
    { status: 'added', messageQuotes },
  );
  const current = { ...draft, messageQuotes };
  assert.deepEqual(appendDraftQuote(current, { ...full, text: 'Updated reply' }), {
    status: 'duplicate',
  });
  assert.deepEqual(appendDraftQuote(current, { ...excerpt, id: 'new-id' }), {
    status: 'duplicate',
  });
  assert.deepEqual(appendDraftQuote(current, { ...file, id: 'new-id', file: { ...file.file } }), {
    status: 'duplicate',
  });
  assert.deepEqual(appendDraftQuote(current, { ...file, file: { ...file.file, endLine: 5 } }), {
    status: 'limit',
  });
  assert.deepEqual(appendDraftQuote(current, { ...excerpt, text: 'Another excerpt' }), {
    status: 'limit',
  });
});

test('draft quote length uses the exact send payload and file quotes retain schema validation', () => {
  const quote: MessageQuote = { id: 'message', text: 'x' };
  const text = 'a'.repeat(composerTextLimit - '\n\n> x'.length);
  assert.deepEqual(appendDraftQuote({ ...draft, text }, quote), {
    status: 'added',
    messageQuotes: [quote],
  });
  assert.deepEqual(appendDraftQuote({ ...draft, text: text + 'a' }, quote), { status: 'tooLong' });
  const file: MessageQuote = {
    ...quote,
    file: { path: 'file.ts', startLine: 1, endLine: 1, version: 'worktree' },
  };
  const fileText = 'a'.repeat(composerTextLimit - '\n\n> file.ts:1 (worktree)\n> x'.length);
  assert.deepEqual(appendDraftQuote({ ...draft, text: fileText }, file), {
    status: 'added',
    messageQuotes: [file],
  });
  assert.deepEqual(appendDraftQuote({ ...draft, text: fileText + 'a' }, file), {
    status: 'tooLong',
  });
  assert.deepEqual(
    appendDraftQuote(draft, {
      ...file,
      file: { path: 'file.ts', startLine: 2, endLine: 1, version: 'worktree' },
    }),
    { status: 'tooLong' },
  );
  assert.equal(appendDraftQuote(draft, { ...quote, text: '' }).status, 'added');
});

const enter: ComposerKey = {
  key: 'Enter',
  isComposing: false,
  keyCode: 13,
  repeat: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
};
const idle = { ime: false, insertAvailable: false };
const composition = { active: false, until: 0 };

test('composition and the 50 ms protection window take precedence over the picker and send', () => {
  assert.equal(isComposerImeKey(enter, { ...composition, active: true }, 100), true);
  assert.equal(isComposerImeKey({ ...enter, isComposing: true }, composition, 100), true);
  assert.equal(isComposerImeKey({ ...enter, keyCode: 229 }, composition, 100), true);
  assert.equal(isComposerImeKey(enter, { ...composition, until: 150 }, 149), true);
  assert.equal(isComposerImeKey(enter, { ...composition, until: 150 }, 150), false);
  assert.equal(
    dispatchComposerKey(enter, {
      ime: true,
      completionConsumed: true,
      insertAvailable: true,
    }),
    'ime',
  );
});

test('the open picker gets navigation and confirmation before ordinary Enter can submit', () => {
  for (const [key, action] of [
    ['Enter', 'choose'],
    ['Tab', 'choose'],
    ['Escape', 'dismiss'],
    ['ArrowUp', 'previous'],
    ['ArrowDown', 'next'],
  ] as const) {
    const event = { ...enter, key };
    const open = selectCompletionKey(event, true, 2);
    const closed = selectCompletionKey(event, false, 2);
    assert.equal(open, action);
    assert.equal(
      dispatchComposerKey(event, { ...idle, completionConsumed: Boolean(open) }),
      'completion',
    );
    assert.equal(
      dispatchComposerKey(event, { ...idle, completionConsumed: Boolean(closed) }),
      key === 'Enter' ? 'submit' : 'default',
    );
  }
  assert.equal(selectCompletionKey(enter, true, 0), undefined);
  assert.equal(selectCompletionKey({ ...enter, key: 'Escape' }, true, 0), 'dismiss');
});

test('modified Enter can insert or keep the textarea default without choosing a candidate', () => {
  for (const modifier of ['ctrlKey', 'altKey'] as const) {
    const event = { ...enter, [modifier]: true };
    const completionConsumed = Boolean(selectCompletionKey(event, true, 2));
    const active = { ...idle, insertAvailable: true, completionConsumed };
    assert.equal(dispatchComposerKey(event, active), 'insert');
    assert.equal(dispatchComposerKey({ ...event, repeat: true }, active), 'ignore');
    assert.equal(dispatchComposerKey(event, { ...idle, completionConsumed }), 'default');
  }
  for (const modifiers of [
    { shiftKey: true },
    { metaKey: true },
    { ctrlKey: true, altKey: true },
    { ctrlKey: true, shiftKey: true },
  ]) {
    const event = { ...enter, ...modifiers };
    assert.equal(
      dispatchComposerKey(event, {
        ...idle,
        insertAvailable: true,
        completionConsumed: Boolean(selectCompletionKey(event, true, 2)),
      }),
      'default',
    );
  }
});
