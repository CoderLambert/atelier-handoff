/**
 * @file 验证 SDK 重建时跨轮次恢复约束、来源和待核对操作。
 * @implementation 验证历史指令与证据归属、分支隔离、早期与近期记录的保留，以及近期对话的 UTF-8 字节预算。
 * @updated 2026-11-22T18:16:38+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import type { Message, Run, ToolCall } from '../shared/types.js';
import {
  recentConversationContext,
  sessionCheckpointByteLimit,
  sessionRecoveryContext,
} from '../server/session-checkpoint.js';

const stamp = '2026-11-22T00:00:00.000Z';
function task(id: string, prompt: string, patch: Partial<Run> = {}): Run {
  return {
    id,
    sessionId: 's',
    projectId: 'p',
    executor: 'native-v1',
    prompt,
    mode: 'edit',
    status: 'completed',
    createdAt: stamp,
    startedAt: stamp,
    endedAt: stamp,
    reason: null,
    error: null,
    retryOf: null,
    contextPaths: [],
    attachmentIds: [],
    plan: [],
    usage: null,
    config: { gateway: 'http://127.0.0.1:9', model: 'fixture', maxTurns: 4, timeoutMs: 10000 },
    ...patch,
  };
}
function user(run: Run, text: string, id = `msg-${run.id}`): Message {
  return { id, runId: run.id, sessionId: run.sessionId, text, role: 'user', createdAt: stamp };
}
function tool(run: Run, name: string, output: string, id = `${name}-${run.id}`): ToolCall {
  return {
    id,
    runId: run.id,
    sessionId: run.sessionId,
    name,
    status: 'succeeded',
    inputSummary: 'secret command args',
    output,
    startedAt: stamp,
    endedAt: stamp,
  };
}
const list = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), omitted: z.number() });
const receipt = z.object({ runId: z.string(), toolCallId: z.string(), tool: z.string() });
const schema = z.object({
  schemaVersion: z.literal(2),
  latestRun: z.object({ id: z.string() }),
  shortened: z.boolean(),
  runCount: z.number(),
  userRequests: list(z.object({ runId: z.string(), text: z.string() })),
  discoveredSources: list(
    z.object({ runId: z.string(), url: z.string(), status: z.literal('discovered_only') }),
  ),
  effectsToVerify: list(receipt.extend({ state: z.literal('unverified') })),
  toolReceipts: list(receipt),
  previousUnresolved: list(receipt),
});
const decode = (context: string) =>
  schema.parse(JSON.parse(context.slice(context.indexOf('\n') + 1)));

test('a progress-only turn cannot replace earlier user instructions, corrections, source URLs or uncertain effects', () => {
  const a = task('a', 'Check the release. Do not install.');
  const b = task('b', 'Give me a progress update.');
  const current = task('c', 'Check the pending changes.');
  const output = sessionRecoveryContext(current, {
    runs: [a, b, current],
    messages: [
      user(a, a.prompt),
      user(a, 'Correction: check stable releases only.', 'steer'),
      user(b, b.prompt),
      { ...user(b, 'not a verified fact'), role: 'assistant' },
      user(current, current.prompt),
    ],
    tools: [
      tool(
        a,
        'mcp__atelier__web_search',
        JSON.stringify({
          sources: [{ url: 'https://docs.example.org/release?token=private-value#foo' }],
        }),
      ),
      { ...tool(a, 'Bash', 'private-output'), status: 'canceled' },
    ],
  });
  const cp = decode(output);
  assert.equal(cp.latestRun.id, 'b');
  assert.deepEqual(
    cp.userRequests.items.map((x) => x.text),
    [a.prompt, 'Correction: check stable releases only.', b.prompt],
  );
  assert.deepEqual(cp.discoveredSources.items, [
    { runId: 'a', url: 'https://docs.example.org/release', status: 'discovered_only' },
  ]);
  assert.equal(cp.effectsToVerify.items[0]?.toolCallId, 'Bash-a');
  assert.equal(cp.toolReceipts.items[0]?.runId, 'a');
  assert.doesNotMatch(
    output,
    /private-value|private-output|secret command args|not a verified fact|Check the pending changes/,
  );
});

test('only preceding eligible runs in the current session/project contribute recovery data', () => {
  const legacy = task('legacy', 'eligible', { executor: undefined });
  const current = task('current', 'now', { executor: 'project-v1' });
  const excluded = [
    task('priv', 'foreign-native'),
    task('agent', 'foreign-agent', {
      executor: 'project-v1',
      agent: { id: 'a', revisionId: 'other', name: 'bound', version: 1, capabilities: [] },
    }),
    task('other', 'foreign-session', { sessionId: 'other' }),
    task('outside', 'foreign-project', { projectId: 'other', executor: 'project-v1' }),
  ];
  const future = task('future', 'foreign-future', { executor: 'project-v1' });
  const text = sessionRecoveryContext(current, {
    runs: [...excluded, legacy, current, future],
    messages: [user(legacy, 'foreign-message', 'leak')].map((x) => ({ ...x, sessionId: 'wrong' })),
    tools: [{ ...tool(legacy, 'Read', 'irrelevant', 'foreign-tool'), sessionId: 'wrong' }],
  });
  assert.deepEqual(decode(text).userRequests.items, [{ runId: legacy.id, text: legacy.prompt }]);
  assert.doesNotMatch(text, /foreign-/);
  assert.equal(
    sessionRecoveryContext(current, { runs: [current, future], messages: [], tools: [] }),
    '',
  );
});

test('long Unicode histories preserve early anchors, latest requests and unverified writes inside one byte budget', () => {
  const runs = Array.from({ length: 120 }, (_, i) =>
    task(`r${i}`, `第${i}轮：${'核验内容'.repeat(350)}`),
  );
  const current = task('current', 'new');
  const tools = runs.flatMap((run) => [
    tool(run, 'Read', 'secret file bytes'),
    tool(run, 'Bash', 'secret shell bytes'),
  ]);
  const text = sessionRecoveryContext(current, {
    runs: [...runs, current],
    messages: runs.map((run) => user(run, run.prompt)),
    tools,
  });
  const cp = decode(text);
  assert.ok(Buffer.byteLength(text) <= sessionCheckpointByteLimit);
  assert.ok(cp.shortened);
  assert.equal(cp.runCount, 120);
  assert.equal(cp.userRequests.items[0]?.runId, 'r0');
  assert.equal(cp.userRequests.items.at(-1)?.runId, 'r119');
  assert.ok(cp.userRequests.omitted > 0);
  assert.equal(cp.effectsToVerify.items[0]?.runId, 'r0');
  assert.equal(cp.effectsToVerify.items.at(-1)?.runId, 'r119');
  assert.ok(cp.effectsToVerify.omitted > 0);
  assert.doesNotMatch(text, /secret file bytes|secret shell bytes/);
});

test('a visible inherited instruction survives rebuilding a fork without importing its parent tool history', () => {
  const current = task('fork-run', 'continue', { sessionId: 'fork' });
  const parent = task('parent-run', 'parent only');
  const inherited = [
    { id: 'cut', role: 'user' as const, text: 'Use staged deployment only.', createdAt: stamp },
  ];
  const text = sessionRecoveryContext(
    current,
    {
      runs: [parent, current],
      messages: [],
      tools: [tool(parent, 'Bash', 'parent tool bytes', 'after-cut')],
    },
    inherited,
  );
  assert.match(text, /Use staged deployment only/);
  assert.match(text, /"inherited":true/);
  assert.doesNotMatch(text, /parent-run|after-cut|parent tool bytes/);
});

test('large conversation tails use valid UTF-8, retain the speaker and respect the 96 KiB budget', () => {
  const current = task('c', 'current');
  const past = task('a', 'past');
  const messages = [
    user(past, 'early'),
    { ...user(past, '🐈'.repeat(40_000) + 'tail'), role: 'assistant' as const },
    user(past, 'latest'),
    user(current, 'must not echo'),
  ];
  const context = recentConversationContext(current, messages, []);
  assert.ok(Buffer.byteLength(context) <= 96 * 1024);
  assert.match(context, /仅恢复最近.*\nassistant: \[前文已省略\]/u);
  assert.ok(context.endsWith('tail\n\nuser: latest'));
  assert.doesNotMatch(context, /�|must not echo|early/);
  assert.equal(recentConversationContext(current, [user(past, 'small')], []), 'user: small');
});

test('early receipts within a single noisy run retain a durable lookup handle', () => {
  const a = task('a', 'Wait for confirmation before changing settings.');
  const b = task('b', 'Status?');
  const c = task('c', 'Review.');
  const history = Array.from({ length: 70 }, (_, i) =>
    tool(a, 'Bash', 'raw result', `action-${i}`),
  );
  const cp = decode(sessionRecoveryContext(c, { runs: [a, b, c], messages: [], tools: history }));
  assert.equal(cp.effectsToVerify.items[0]?.toolCallId, 'action-0');
  assert.equal(cp.effectsToVerify.items.at(-1)?.toolCallId, 'action-69');
  assert.ok(cp.effectsToVerify.omitted > 0);
});
