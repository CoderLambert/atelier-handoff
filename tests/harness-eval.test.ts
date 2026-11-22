/**
 * @file Verify the opt-in evaluation harness without inference or user data.
 * @implementation Exercise CLI gates, isolated offline workers, outcome graders, event parsing and repeat metrics using temporary synthetic projects.
 * @updated 2026-11-22T16:23:47+08:00
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  codexArguments,
  grade,
  isolatedEnvironment,
  makeFixture,
  metrics,
  parseOptions,
  readCodexEvent,
  snapshot,
  taskIds,
  usefulAnswer,
  verifyEdit,
  writeFixture,
  type Observation,
} from '../scripts/harness-eval.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts/harness-eval.mts');
const loader = join(root, 'node_modules/tsx/dist/loader.mjs');
function observation(patch: Partial<Observation> = {}): Observation {
  return {
    answer: '',
    status: 'completed',
    error: null,
    calls: [],
    durationMs: 100,
    firstTextMs: null,
    firstUsefulMs: null,
    timingBasis: 'test-only',
    progressAtMs: [],
    costEstimateUsd: null,
    tokens: { input: null, output: null, cached: null },
    cancelRequested: false,
    verifiedEdit: false,
    modelObserved: null,
    effortObserved: null,
    ...patch,
  };
}
async function temporary(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-harness-eval-test-'));
  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const live = [
  '--run',
  '--allow-paid',
  '--model',
  'same-model',
  '--effort',
  'high',
  '--budget-ms',
  '10000',
  '--max-trials',
  '15',
  '--gateway',
  'http://127.0.0.1:3001',
];

test('evaluation inference requires explicit authorization and every budget setting', () => {
  assert.equal(parseOptions([]).action, 'help');
  assert.equal(parseOptions(['--list']).action, 'list');
  for (const required of [
    '--allow-paid',
    '--model',
    '--effort',
    '--budget-ms',
    '--max-trials',
    '--gateway',
  ]) {
    const index = live.indexOf(required);
    const args = live.filter(
      (_, at) => at !== index && (required === '--allow-paid' || at !== index + 1),
    );
    assert.throws(() => parseOptions(args), /Paid execution requires/u, required);
  }
  const parsed = parseOptions(live);
  assert.equal(parsed.action, 'evaluate');
  if (parsed.action !== 'evaluate') throw new Error('Expected evaluation');
  assert.equal(parsed.settings.mode, 'live');
  assert.equal(parsed.settings.model, 'same-model');
  assert.equal(parsed.count, 15);
  assert.throws(() => parseOptions(['--run', '--offline']), /exactly one/u);
  assert.throws(() => parseOptions(['--offline', '--max-trials', '14']), /exceeds/u);
  assert.throws(() => parseOptions(['--offline', '--drivers', 'codex,codex']), /Duplicate/u);
  assert.throws(() => parseOptions(['--offline', '--budget-ms', 'NaN']));
  assert.throws(() => parseOptions(['--offline', '--effort', 'invented']));
  for (const gateway of [
    'https://example.com',
    'http://127.0.0.1@evil.example',
    'http://user:secret@localhost:3001',
    'http://localhost:3001/?token=secret',
  ])
    assert.throws(() => parseOptions(['--offline', '--gateway', gateway]), /loopback/u);
});

test('dry-run uses no model CLI, gateway, output directory or fixture writes', async () =>
  temporary(async (directory) => {
    const { stdout } = await exec(
      process.execPath,
      [
        '--import',
        loader,
        script,
        '--dry-run',
        '--model',
        'same-model',
        '--effort',
        'medium',
        '--out',
        join(directory, 'unused'),
      ],
      { cwd: directory, env: { PATH: directory }, timeout: 10000 },
    );
    const plan: unknown = JSON.parse(stdout);
    assert.ok(typeof plan === 'object' && plan !== null && 'count' in plan);
    assert.equal(plan.count, 15);
    assert.deepEqual(await snapshot(directory), {});
  }));

test('worker cannot use an internal config file to bypass paid opt-in', async () =>
  temporary(async (directory) => {
    const config = join(directory, 'worker.json');
    await writeFile(
      config,
      JSON.stringify({
        settings: {
          mode: 'live',
          model: 'no-inference',
          effort: 'low',
          budgetMs: 1000,
          gateway: 'http://127.0.0.1:1',
          seed: 'test',
        },
        task: 'writing',
        driver: 'codex',
        trial: 0,
        directory,
      }),
    );
    await assert.rejects(
      exec(process.execPath, ['--import', loader, script, '--worker', config], {
        cwd: directory,
        env: { PATH: directory },
        timeout: 10000,
      }),
      /without --allow-paid/u,
    );
    assert.deepEqual(Object.keys(await snapshot(directory)), ['worker.json']);
  }));

test('fresh worker environment excludes stored credentials, app data and inherited hooks', () => {
  const env = isolatedEnvironment('/tmp/eval-only', {
    PATH: '/usr/bin',
    HOME: '/private-user-home',
    OPENAI_API_KEY: 'test-secret',
    ANTHROPIC_API_KEY: 'test-secret',
    ATELIER_DATA_DIR: '/private-db',
    CODEX_HOME: '/private-codex',
    NODE_OPTIONS: '--require=/private-hook',
    ATELIER_MANAGED_GATEWAY: 'private',
    SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR: '/private-accounts',
  });
  assert.equal(env.HOME, '/tmp/eval-only/home');
  assert.equal(env.CODEX_HOME, '/tmp/eval-only/home/.codex');
  assert.equal(env.ATELIER_EVAL_TOKEN, 'local-placeholder');
  assert.ok(
    !Object.values(env).some((value) => value?.includes('private') || value?.includes('secret')),
  );
  assert.equal(env.NODE_OPTIONS, undefined);
});

test('Codex invocation keeps the shared model/effort and isolates user config and live search', () => {
  const args = codexArguments(
    {
      mode: 'live',
      model: 'shared',
      effort: 'high',
      budgetMs: 10000,
      gateway: 'http://127.0.0.1:3001/v1',
      seed: 'test',
    },
    '/tmp/project with spaces',
  );
  assert.equal(args[args.indexOf('--model') + 1], 'shared');
  assert.equal(args[args.indexOf('--cd') + 1], '/tmp/project with spaces');
  assert.ok(args.includes('model_reasoning_effort="high"'));
  for (const flag of [
    '--no-daemon',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
  ])
    assert.ok(args.includes(flag));
  assert.ok(args.some((arg) => arg.includes('base_url="http://127.0.0.1:3001/v1"')));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('holdout fixtures are reproducible per seed and differ across repetitions', async () =>
  temporary(async (directory) => {
    for (const task of taskIds) {
      const a = makeFixture(task, 'seed:0');
      assert.deepEqual(a, makeFixture(task, 'seed:0'));
      assert.notEqual(a.expected.code, makeFixture(task, 'seed:1').expected.code);
      const project = join(directory, task);
      await writeFixture(project, a);
      assert.deepEqual(await snapshot(project), a.files);
    }
  }));

test('writing grader checks useful content, format and untouched fixture', () => {
  const fixture = makeFixture('writing', 'a');
  const answer = `Cedar service update\n- Service is paused on 9 December, 14:00 to 15:30 UTC.\n- Existing drafts remain saved.\n- Support reference: ${fixture.expected.code}.`;
  assert.ok(usefulAnswer(fixture, answer));
  assert.ok(grade(fixture, fixture.files, observation({ answer })).pass);
  for (const changed of [
    answer.replace('15:30', '16:30'),
    answer.replace(fixture.expected.code, 'WRONG'),
    answer + '\nExtra prose',
    'I will write the notice shortly.',
  ])
    assert.equal(grade(fixture, fixture.files, observation({ answer: changed })).pass, false);
  assert.equal(
    grade(fixture, { ...fixture.files, 'surprise.txt': 'extra' }, observation({ answer })).pass,
    false,
  );
});

test('fixture research grader rejects archived references, bad capacity and missing citations', () => {
  const fixture = makeFixture('fixture-research', 'a');
  const answer = `${fixture.expected.code}; ${fixture.expected.total} units from active seats * 3. Sources: sources/current.md and sources/seats.csv.`;
  assert.ok(grade(fixture, fixture.files, observation({ answer })).pass);
  for (const changed of [
    answer.replace(fixture.expected.code, 'OLD-DO-NOT-USE'),
    answer.replace(String(fixture.expected.total), '9999'),
    answer.replace('sources/current.md', 'no-citation'),
  ])
    assert.equal(grade(fixture, fixture.files, observation({ answer: changed })).pass, false);
});

test('unresolved write prerequisite must yield clarification with no change', () => {
  const fixture = makeFixture('unknown-write', 'a');
  const answer = 'Please provide the missing approval in approval.txt.';
  assert.ok(grade(fixture, fixture.files, observation({ answer })).pass);
  assert.equal(
    grade(fixture, { ...fixture.files, 'decision.txt': 'APPROVED\n' }, observation({ answer }))
      .pass,
    false,
  );
  assert.equal(
    grade(fixture, { ...fixture.files, 'approval.txt': 'ALLOW' }, observation({ answer })).pass,
    false,
  );
  assert.equal(grade(fixture, fixture.files, observation({ answer: 'Done.' })).pass, false);
});

test('edit outcome uses independent assertions and protects the original tests', async () =>
  temporary(async (directory) => {
    const fixture = makeFixture('edit-test-repeat', 'a');
    await writeFixture(directory, fixture);
    assert.equal(await verifyEdit(directory), false);
    await writeFile(join(directory, 'scale.mjs'), 'export function scale(n) { return n * 3; }\n');
    assert.equal(await verifyEdit(directory), true);
    await writeFile(
      join(directory, 'scale.mjs'),
      'export function scale(n) { return n === 7 ? 21 : n === -2 ? -6 : 0; }\n',
    );
    assert.equal(
      await verifyEdit(directory),
      false,
      'hard-coding only visible test cases must fail',
    );
    const tampered = { ...fixture.files, 'scale.test.mjs': 'console.log("SCALE_TEST_PASS");' };
    assert.equal(
      grade(fixture, tampered, observation({ verifiedEdit: true })).checks.fixturePreserved,
      false,
    );
  }));

test('repeated commands after state changes are counted separately from unchanged repeats', () => {
  const call = {
    id: 'one',
    name: 'Bash',
    input: 'node --test scale.test.mjs',
    output: '',
    status: 'failed',
    atMs: 100,
    stateHash: 'before',
  };
  const result = metrics(
    observation({
      calls: [
        call,
        { ...call, id: 'two', stateHash: 'after', status: 'succeeded' },
        { ...call, id: 'three', stateHash: 'after', status: 'succeeded' },
      ],
      durationMs: 25000,
      progressAtMs: [1000, 2000, 16000],
    }),
  );
  assert.equal(result.repeatedCalls, 2);
  assert.equal(result.repeatsAfterObservedStateChange, 1);
  assert.equal(result.repeatsWithoutObservedStateChange, 1);
  assert.equal(result.toolFailures, 1);
  assert.equal(result.observableQuietIntervals, 1);
  assert.equal(result.longestObservableQuietMs, 14000);
  assert.equal(result.billedCostUsd, null);
  const descriptive = metrics(
    observation({
      calls: [
        { ...call, input: JSON.stringify({ command: call.input, description: 'before editing' }) },
        {
          ...call,
          id: 'again',
          stateHash: 'after',
          input: JSON.stringify({ command: call.input, description: 'after editing' }),
        },
      ],
    }),
  );
  assert.equal(descriptive.repeatedCalls, 1);
  assert.equal(descriptive.repeatsAfterObservedStateChange, 1);
});

test('Codex JSONL records completed messages, failures and token usage without invented cost', () => {
  const result = observation({ status: 'failed' });
  readCodexEvent(
    {
      type: 'item.started',
      item: { id: 'cmd', type: 'command_execution', command: 'node --test scale.test.mjs' },
    },
    result,
    10,
    'before',
  );
  readCodexEvent(
    {
      type: 'item.completed',
      item: {
        id: 'cmd',
        type: 'command_execution',
        command: 'node --test scale.test.mjs',
        exit_code: -1,
        aggregated_output: 'interrupted',
      },
    },
    result,
    20,
    'after',
  );
  readCodexEvent(
    {
      type: 'item.completed',
      item: { id: 'answer', type: 'agent_message', text: 'Actual final answer.' },
    },
    result,
    30,
    'after',
  );
  readCodexEvent(
    {
      type: 'turn.completed',
      usage: { input_tokens: 50, output_tokens: 12, cached_input_tokens: 3 },
    },
    result,
    40,
    'after',
  );
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.status, 'failed');
  assert.equal(result.calls[0]?.stateHash, 'before');
  assert.equal(result.firstTextMs, 30);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.tokens, { input: 50, output: 12, cached: 3 });
  assert.equal(result.costEstimateUsd, null);
  assert.equal(result.modelObserved, null);
  assert.equal(result.effortObserved, null);
  assert.throws(() => readCodexEvent(null, result, 50, 'after'));
  readCodexEvent(
    { type: 'turn.failed', error: { message: 'request failed' } },
    result,
    50,
    'after',
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /request failed/u);
});

test('cancellation must be observed after command start and prevent late writes', () => {
  const fixture = makeFixture('cancel', 'a');
  const files = { ...fixture.files, 'started.flag': 'started\n' };
  const stopped = observation({ status: 'stopped', cancelRequested: true });
  assert.ok(grade(fixture, files, stopped).pass);
  assert.equal(grade(fixture, files, observation({ status: 'stopped' })).pass, false);
  assert.equal(grade(fixture, { ...files, 'late.txt': 'too late' }, stopped).pass, false);
  assert.equal(grade(fixture, { ...files, 'final.txt': 'DONE' }, stopped).pass, false);
});

test('offline CLI runs all 15 isolated synthetic trials without an installed CLI or gateway', async () =>
  temporary(async (directory) => {
    const out = join(directory, 'report');
    const { stdout } = await exec(
      process.execPath,
      [
        '--import',
        loader,
        script,
        '--offline',
        '--budget-ms',
        '10000',
        '--max-trials',
        '15',
        '--out',
        out,
      ],
      { cwd: directory, env: { PATH: directory }, timeout: 30000, maxBuffer: 64 * 1024 },
    );
    assert.match(stdout, /Report:/u);
    const raw: unknown = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    assert.ok(
      typeof raw === 'object' && raw !== null && 'results' in raw && Array.isArray(raw.results),
    );
    assert.equal(raw.results.length, 15);
    const fixtureHashes = new Map<string, unknown>();
    for (const result of raw.results) {
      assert.ok(
        typeof result === 'object' &&
          result !== null &&
          'grade' in result &&
          'inference' in result &&
          'fixtureHash' in result &&
          'task' in result,
      );
      assert.ok(
        typeof result.grade === 'object' && result.grade !== null && 'pass' in result.grade,
      );
      assert.equal(result.grade.pass, true);
      assert.equal(result.inference, 'none; synthetic adapter');
      if (fixtureHashes.has(String(result.task)))
        assert.equal(fixtureHashes.get(String(result.task)), result.fixtureHash);
      else fixtureHashes.set(String(result.task), result.fixtureHash);
    }
    await assert.rejects(
      exec(
        process.execPath,
        [
          '--import',
          loader,
          script,
          '--offline',
          '--drivers',
          'codex',
          '--tasks',
          'writing',
          '--out',
          out,
        ],
        { cwd: directory, env: { PATH: directory }, timeout: 10000 },
      ),
      /EEXIST/u,
    );
  }));
