import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PreToolUseHookInput, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalGate, ProjectPaths, ToolPolicy } from './policy.js';
import { EventObserver, MessageInput } from './events.js';

async function fixture(run: (root: string, outside: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'atelier-t01-offline-'));
  const root = join(base, 'workspace'); const outside = join(base, 'outside.txt');
  await mkdir(root); await writeFile(join(root, 'note.txt'), 'ORIGINAL\n'); await writeFile(outside, 'SENTINEL');
  try { await run(root, outside); } finally { await rm(base, { recursive: true }); }
}
const noop = () => {};
function hook(root: string, input: Record<string, unknown>, name = 'Edit', id = 'tool-1'): PreToolUseHookInput {
  return { hook_event_name: 'PreToolUse', session_id: 'offline', transcript_path: '', cwd: root, tool_name: name, tool_input: input, tool_use_id: id };
}
const edit = { file_path: 'note.txt', old_string: 'ORIGINAL', new_string: 'APPROVED' };
const context = () => ({ signal: new AbortController().signal });
const permissionContext = (signal = new AbortController().signal) => ({ signal, toolUseID: 'tool-1', requestId: 'request-1' });

test('paths allow existing regular files and new leaves, reject traversal and similar prefixes', async () => fixture(async (root, outside) => {
  const paths = new ProjectPaths(root);
  assert.equal(await paths.check('note.txt'), join(root, 'note.txt'));
  assert.equal(await paths.check('new.txt', true), join(root, 'new.txt'));
  for (const value of [outside, '../outside.txt', root + '-other/file', 'sub/../note.txt', '~/.env', '', 'x\0y', '.']) await assert.rejects(paths.check(value, true));
  await assert.rejects(paths.check('missing/child.txt', true));
}));

test('paths reject external, internal and dangling symlinks, including parents', async () => fixture(async (root, outside) => {
  await symlink(outside, join(root, 'escape.txt'));
  await symlink(join(root, 'note.txt'), join(root, 'internal.txt'));
  await symlink(join(root, 'missing.txt'), join(root, 'dangling.txt'));
  await symlink(join(root, '..'), join(root, 'parent'));
  const paths = new ProjectPaths(root);
  for (const value of ['escape.txt', 'internal.txt', 'dangling.txt', 'parent/new.txt']) await assert.rejects(paths.check(value, true));
}));

test('paths reject hard links and directories as file targets', async () => fixture(async (root, outside) => {
  await link(outside, join(root, 'hard.txt')); await mkdir(join(root, 'dir'));
  await assert.rejects(new ProjectPaths(root).check('hard.txt'));
  await assert.rejects(new ProjectPaths(root).check('dir'));
}));

test('approval cancellation wins and all late or duplicate decisions are ignored', async () => {
  const controller = new AbortController(); const gate = new ApprovalGate(controller.signal);
  controller.abort(); assert.equal(gate.settle('allowed'), false);
  assert.equal(await gate.promise, 'canceled'); assert.equal(gate.settle('denied'), false);
  const allowed = new ApprovalGate(new AbortController().signal);
  assert.equal(allowed.settle('allowed'), true); assert.equal(allowed.settle('allowed'), false);
  assert.equal(await allowed.promise, 'allowed');
});

test('approval expiry produces a terminal denial, including already-aborted signals', async () => {
  const gate = new ApprovalGate(new AbortController().signal, 5);
  assert.equal(await gate.promise, 'expired'); assert.equal(gate.settle('allowed'), false);
  const aborted = new ApprovalGate(AbortSignal.abort()); assert.equal(await aborted.promise, 'canceled');
});

test('write requires a matching snapshot; allowed input and file preview are exact', async () => fixture(async root => {
  const policy = new ToolPolicy(root, ['Edit'], new AbortController().signal, noop, (operation, gate) => {
    assert.equal(operation.before, 'ORIGINAL\n'); assert.equal(operation.after, 'APPROVED\n'); gate.settle('allowed');
  });
  const output = await policy.preToolUse(hook(root, edit), 'tool-1', context());
  assert.ok('hookSpecificOutput' in output && output.hookSpecificOutput?.hookEventName === 'PreToolUse' && output.hookSpecificOutput.permissionDecision === 'ask');
  assert.equal((await policy.canUseTool('Edit', edit, permissionContext()))?.behavior, 'allow');
  assert.equal((await policy.canUseTool('Edit', edit, permissionContext()))?.behavior, 'deny');
}));

test('changing operation arguments after the hook denies the request', async () => fixture(async root => {
  const policy = new ToolPolicy(root, ['Edit'], new AbortController().signal, noop, (_op, gate) => { gate.settle('allowed'); });
  await policy.preToolUse(hook(root, edit), 'tool-1', context());
  assert.equal((await policy.canUseTool('Edit', { ...edit, new_string: 'SURPRISE' }, permissionContext()))?.behavior, 'deny');
}));

test('changing the file baseline while awaiting approval denies a previously approved edit', async () => fixture(async root => {
  const policy = new ToolPolicy(root, ['Edit'], new AbortController().signal, noop, async (_op, gate) => {
    await writeFile(join(root, 'note.txt'), 'CONCURRENT CHANGE\n'); gate.settle('allowed');
  });
  await policy.preToolUse(hook(root, edit), 'tool-1', context());
  assert.equal((await policy.canUseTool('Edit', edit, permissionContext()))?.behavior, 'deny');
  assert.equal(policy.decisions[0]?.decision, 'stale');
}));

test('canceling in the async decision handler never grants the write', async () => fixture(async root => {
  const controller = new AbortController();
  const policy = new ToolPolicy(root, ['Edit'], controller.signal, noop, (_op, gate) => { controller.abort(); assert.equal(gate.settle('allowed'), false); });
  await policy.preToolUse(hook(root, edit), 'tool-1', context());
  assert.equal((await policy.canUseTool('Edit', edit, permissionContext()))?.behavior, 'deny');
  assert.equal(policy.decisions[0]?.decision, 'canceled');
}));

test('unknown tools and outside reads are denied by hooks even without a permission callback', async () => fixture(async (root, outside) => {
  const policy = new ToolPolicy(root, ['Read'], new AbortController().signal, noop, noop);
  for (const event of [hook(root, { command: 'ls' }, 'Bash'), hook(root, { file_path: outside }, 'Read')]) {
    const result = await policy.preToolUse(event, 'tool-1', context());
    assert.ok('hookSpecificOutput' in result && result.hookSpecificOutput?.hookEventName === 'PreToolUse' && result.hookSpecificOutput.permissionDecision === 'deny');
  }
}));

test('tool parameter completion cannot mark execution successful; tool results correlate by ID', () => {
  const observer = new EventObserver(noop);
  const tool = { type: 'assistant', message: { id: 'message-1', model: 'fixture', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'note.txt' } }] } } as unknown as SDKMessage;
  observer.observe(tool);
  observer.observe({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } } as SDKMessage);
  assert.equal(observer.successfulTool('Read'), false);
  observer.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'other-call', content: 'wrong' }] } } as SDKMessage);
  assert.equal(observer.successfulTool('Read'), false);
  observer.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: false, content: 'ok' }] } } as SDKMessage);
  assert.equal(observer.successfulTool('Read'), true);
});

test('partial and completed text are separate; repeated complete blocks do not duplicate text', () => {
  const observer = new EventObserver(noop);
  observer.observe({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } } } as SDKMessage);
  const block = { type: 'assistant', message: { id: 'message-1', model: 'fixture', content: [{ type: 'text', text: 'hello' }] } } as unknown as SDKMessage;
  observer.observe(block); observer.observe(block);
  assert.equal(observer.finalText(), 'hello'); assert.equal(observer.textDeltas, 1);
  assert.equal(observer.summary().actualBillingUsd, null);
});

test('a tool error remains failure; unknown events and missing usage do not produce false success', () => {
  const observer = new EventObserver(noop);
  observer.observe({ type: 'new_sdk_event', subtype: 'unknown' } as unknown as SDKMessage);
  observer.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'failed' }] } } as SDKMessage);
  assert.equal(observer.toolResults.get('call-1'), false); assert.equal(observer.results.length, 0);
  assert.ok(observer.eventTypes.has('new_sdk_event:unknown'));
});

test('streaming input wakes on new input and terminates without accepting late messages', async () => {
  const input = new MessageInput<string>(); const iterator = input[Symbol.asyncIterator]();
  const pending = iterator.next(); input.push('first'); assert.deepEqual(await pending, { value: 'first', done: false });
  const ended = iterator.next(); input.end(); assert.equal((await ended).done, true);
  assert.throws(() => input.push('late'), /INPUT_CLOSED/);
});
