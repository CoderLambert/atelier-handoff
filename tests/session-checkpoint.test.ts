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
import { canReadToolOutput } from '../server/tool-output-context.js';

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
function fetch(run: Run, id: string, url: string, patch: Partial<ToolCall> = {}): ToolCall {
  return {
    ...tool(run, 'WebFetch', 'RAW_FETCH_BODY', id),
    inputSummary: JSON.stringify({ url, prompt: 'PRIVATE_FETCH_PROMPT' }),
    ...patch,
  };
}
const list = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), omitted: z.number() });
const receipt = z.object({
  runId: z.string(),
  toolCallId: z.string(),
  tool: z.string(),
  outcome: z.enum([
    'completed',
    'temporary_failure',
    'permanent_failure',
    'running',
    'uncertain',
    'canceled',
  ]),
});
const schema = z.object({
  schemaVersion: z.literal(2),
  latestRun: z.object({ id: z.string() }),
  shortened: z.boolean(),
  runCount: z.number(),
  userRequests: list(z.object({ runId: z.string(), text: z.string() })),
  discoveredSources: list(
    z.object({ runId: z.string(), url: z.string(), status: z.literal('discovered_only') }),
  ),
  fetchedSources: list(
    z.object({
      runId: z.string(),
      toolCallId: z.string(),
      url: z.string(),
      status: z.literal('completed'),
    }),
  ),
  confirmedChanges: list(receipt.extend({ state: z.literal('confirmed') })),
  effectsToVerify: list(receipt.extend({ state: z.literal('unverified') })),
  toolReceipts: list(receipt),
  previousUnresolved: list(receipt),
  previousOpenSteps: list(z.object({ runId: z.string(), content: z.string(), status: z.string() })),
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

test('completed WebFetch receipts link redacted request URLs to their IDs without importing page content', () => {
  const past = task('past', 'Review the fetched release.');
  const current = task('current', 'Continue.');
  const url = 'https://alice:credential@example.org/release?token=PRIVATE_QUERY#PRIVATE_FRAGMENT';
  const result = fetch(past, 'fetch-result', url, {
    output: '{"result":"RAW_FETCH_BODY https://unrelated.example.org/injected-source',
    outputTruncated: true,
  });
  const output = sessionRecoveryContext(current, {
    runs: [past, current],
    messages: [],
    tools: [
      tool(
        past,
        'WebSearch',
        JSON.stringify({ sources: [{ url, title: 'PRIVATE_TITLE', excerpt: 'PRIVATE_EXCERPT' }] }),
        'search-result',
      ),
      result,
      fetch(past, 'later-fetch', 'https://example.org/release?token=OTHER_QUERY'),
    ],
  });
  const cp = decode(output);
  assert.deepEqual(cp.fetchedSources.items, [
    {
      runId: past.id,
      toolCallId: result.id,
      url: 'https://example.org/release',
      status: 'completed',
    },
    {
      runId: past.id,
      toolCallId: 'later-fetch',
      url: 'https://example.org/release',
      status: 'completed',
    },
  ]);
  assert.equal(cp.discoveredSources.items[0]?.status, 'discovered_only');
  assert.equal(
    cp.toolReceipts.items.find((item) => item.toolCallId === result.id)?.outcome,
    'completed',
  );
  assert.match(output, /完成不等于内容已核实/);
  assert.doesNotMatch(
    output,
    /alice|credential|PRIVATE_|OTHER_QUERY|RAW_FETCH_BODY|unrelated\.example\.org|secret command args/,
  );
});

test('failed, denied, canceled and unfinished fetches never become completed source evidence', () => {
  const past = task('past', 'Review.');
  const current = task('current', 'Continue.');
  const statuses: ToolCall['status'][] = [
    'failed',
    'denied',
    'canceled',
    'running',
    'awaiting_permission',
  ];
  const text = sessionRecoveryContext(current, {
    runs: [past, current],
    messages: [],
    tools: statuses.map((status) =>
      fetch(past, `fetch-${status}`, 'https://example.org/release', {
        status,
        output: 'ETIMEDOUT RAW_FAILURE_BODY',
      }),
    ),
  });
  const cp = decode(text);
  assert.deepEqual(cp.fetchedSources.items, []);
  assert.deepEqual(cp.toolReceipts.items, []);
  assert.deepEqual(
    cp.previousUnresolved.items.map(({ toolCallId, outcome }) => [toolCallId, outcome]),
    [
      ['fetch-failed', 'temporary_failure'],
      ['fetch-denied', 'permanent_failure'],
      ['fetch-canceled', 'canceled'],
      ['fetch-running', 'running'],
      ['fetch-awaiting_permission', 'running'],
    ],
  );
  assert.doesNotMatch(text, /RAW_FAILURE_BODY|example\.org/);
});

test('fetch source recovery requires bounded valid HTTP request metadata from WebFetch', () => {
  const past = task('past', 'Review.');
  const current = task('current', 'Continue.');
  const invalid = [
    'not-json',
    '[]',
    'null',
    '{"url":"https://example.org/truncated',
    JSON.stringify({ url: 42 }),
    JSON.stringify({ url: 'file:///private/path' }),
    JSON.stringify({ url: 'javascript:alert(1)' }),
    JSON.stringify({ url: `https://example.org/${'x'.repeat(4096)}` }),
    JSON.stringify({ url: 'https://example.org/oversized', prompt: 'x'.repeat(8192) }),
  ];
  const text = sessionRecoveryContext(current, {
    runs: [past, current],
    messages: [],
    tools: [
      ...invalid.map((inputSummary, i) =>
        fetch(past, `invalid-${i}`, 'https://example.org/ignored', {
          inputSummary,
          output: '{"url":"https://example.org/untrusted-output","result":"RAW_FETCH_BODY"}',
        }),
      ),
      fetch(past, 'pretend-fetch', 'https://example.org/pretend', { name: 'mcp__other__WebFetch' }),
      fetch(past, 'atelier-pretend-fetch', 'https://example.org/pretend', {
        name: 'mcp__atelier__WebFetch',
      }),
    ],
  });
  assert.deepEqual(decode(text).fetchedSources.items, []);
  assert.doesNotMatch(text, /https?:|RAW_FETCH_BODY|private\/path/);
});

test('only native main recovery advertises historical result readback and existing grants stay scoped', () => {
  const past = task('past', 'Review.');
  const current = task('current', 'Continue.');
  const result = fetch(past, 'fetch-result', 'https://example.org/release', {
    subagentId: 'historical-child',
  });
  const text = sessionRecoveryContext(current, {
    runs: [past, current],
    messages: [],
    tools: [result],
  });
  assert.match(text, /优先调用 mcp__atelier__read_tool_output 并传对应 toolCallId/);
  assert.match(text, /仅 native 主会话可跨轮回查，子任务不继承此权限/);
  const reader = { id: 'reader', sessionId: current.sessionId, runId: current.id };
  assert.equal(canReadToolOutput(true, reader, result, new Set()), true);
  assert.equal(
    canReadToolOutput(true, { ...reader, subagentId: 'historical-child' }, result, new Set()),
    false,
  );
  assert.equal(canReadToolOutput(true, { ...reader, sessionId: 'fork' }, result, new Set()), false);
  const modes: Partial<Run>[] = [
    { executor: undefined },
    { executor: 'project-v1' },
    {
      executor: 'project-v1',
      agent: { id: 'bound', revisionId: 'rev', name: 'bound', version: 1, capabilities: [] },
    },
  ];
  for (const mode of modes) {
    const restricted = sessionRecoveryContext(
      { ...current, ...mode },
      {
        runs: [
          { ...past, ...mode },
          { ...current, ...mode },
        ],
        messages: [],
        tools: [result],
      },
    );
    assert.equal(decode(restricted).fetchedSources.items[0]?.toolCallId, result.id);
    assert.match(restricted, /本模式不能跨轮回查工具结果/);
    assert.doesNotMatch(restricted, /read_tool_output|依据工具 ID 回查/);
    assert.equal(canReadToolOutput(false, reader, result, new Set([result.id])), false);
  }
});

test('fetched source indexes exclude foreign projects, sessions, future runs and parent fork history', () => {
  const own = task('own', 'Review.');
  const foreignSession = task('foreign-session', 'Other.', { sessionId: 'elsewhere' });
  const foreignProject = task('foreign-project', 'Other.', { projectId: 'elsewhere' });
  const current = task('current', 'Continue.');
  const future = task('future', 'Later.');
  const runs = [own, foreignSession, foreignProject, current, future];
  const tools = [
    ...runs.map((run) => fetch(run, `fetch-${run.id}`, `https://example.org/${run.id}`)),
    fetch(own, 'wrong-tool-session', 'https://example.org/wrong-tool-session', {
      sessionId: 'elsewhere',
    }),
  ];
  const text = sessionRecoveryContext(current, { runs, messages: [], tools });
  assert.deepEqual(decode(text).fetchedSources.items, [
    {
      runId: own.id,
      toolCallId: 'fetch-own',
      url: 'https://example.org/own',
      status: 'completed',
    },
  ]);
  assert.doesNotMatch(text, /foreign-|future|fetch-current|wrong-tool-session/);
  const fork = task('fork-run', 'Continue.', { sessionId: 'fork' });
  const forkText = sessionRecoveryContext(fork, { runs: [...runs, fork], messages: [], tools }, [
    { id: 'inherited', role: 'user', text: 'Review the release.', createdAt: stamp },
  ]);
  assert.match(forkText, /Review the release/);
  assert.doesNotMatch(forkText, /fetch-own|example\.org\/own|historical-child/);
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

test('all populated recovery sections share the byte cap while fetched receipts retain early and latest handles', () => {
  const runs = Array.from({ length: 40 }, (_, i) =>
    task(`r-${i}`.padEnd(128, 'r'), `第${i}轮：${'核验内容'.repeat(350)}`, {
      plan: Array.from({ length: 10 }, () => ({
        content: '继续核对来源'.repeat(150),
        status: 'pending',
      })),
    }),
  );
  const current = task('current', 'Continue.');
  const tools = runs.flatMap((run, i) => {
    const url = `https://example.org/${i}/${'section'.repeat(80)}?token=PRIVATE_QUERY#PRIVATE_FRAGMENT`;
    return [
      tool(
        run,
        'WebSearch',
        JSON.stringify({ sources: [{ url }] }),
        `search-${i}`.padEnd(128, 's'),
      ),
      fetch(run, `fetch-${i}`.padEnd(128, 'f'), url),
      tool(run, 'Read', 'RAW_FILE_BODY', `read-${i}`.padEnd(128, 'd')),
      tool(run, 'Write', 'RAW_FILE_BODY', `write-${i}`.padEnd(128, 'w')),
      {
        ...tool(run, 'Bash', 'RAW_COMMAND_BODY', `bash-${i}`.padEnd(128, 'b')),
        status: 'canceled' as const,
      },
      fetch(run, `failure-${i}`.padEnd(128, 'x'), url, { status: 'failed', output: 'HTTP 404' }),
    ];
  });
  const text = sessionRecoveryContext(current, {
    runs: [...runs, current],
    messages: runs.map((run) => user(run, run.prompt)),
    tools,
  });
  const cp = decode(text);
  assert.ok(Buffer.byteLength(text) <= sessionCheckpointByteLimit);
  assert.equal(cp.shortened, true);
  assert.equal(cp.fetchedSources.items[0]?.toolCallId, 'fetch-0'.padEnd(128, 'f'));
  assert.equal(cp.fetchedSources.items.at(-1)?.toolCallId, 'fetch-39'.padEnd(128, 'f'));
  for (const section of [
    cp.userRequests,
    cp.discoveredSources,
    cp.fetchedSources,
    cp.toolReceipts,
    cp.confirmedChanges,
    cp.effectsToVerify,
    cp.previousUnresolved,
    cp.previousOpenSteps,
  ]) {
    assert.ok(section.items.length > 0);
    assert.ok(section.omitted > 0);
  }
  assert.doesNotMatch(text, /PRIVATE_|RAW_|PRIVATE_FETCH_PROMPT/);
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
