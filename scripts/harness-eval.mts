/**
 * @file Run opt-in, isolated cross-task evaluations of Atelier and installed Codex.
 * @implementation Fresh fixtures and scrubbed worker environments share prompts and wall budgets; offline graders produce per-trial evidence without a model judge.
 * @updated 2026-11-22T16:23:47+08:00
 */
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

export const drivers = ['atelier-controlled', 'atelier-native', 'codex'] as const;
export const taskIds = [
  'writing',
  'fixture-research',
  'edit-test-repeat',
  'unknown-write',
  'cancel',
] as const;
export type Driver = (typeof drivers)[number];
export type TaskId = (typeof taskIds)[number];
const driverSchema = z.enum(drivers);
const taskSchema = z.enum(taskIds);
const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const source = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);
const exec = promisify(execFile);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const record = z.record(z.string(), z.unknown());
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const numeric = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const active = new Set(['queued', 'running', 'awaiting_permission', 'stopping']);
const preamble =
  'Work only in the current fixture project. Use no network, external services, installed skills, secrets, or files outside this project. Do not execute any git command. Do not install dependencies. Use Node.js built-ins when needed. Complete the requested task and report actual results.\n\n';

export interface Fixture {
  task: TaskId;
  prompt: string;
  files: Record<string, string>;
  expected: { code: string; total: number };
  initialHash: string;
}

export function makeFixture(task: TaskId, seed: string): Fixture {
  const code = `C${digest(seed).slice(0, 7).toUpperCase()}`;
  const units = 12 + (Number.parseInt(digest(seed).slice(0, 2), 16) % 20);
  const files: Record<string, string> = {
    'AGENTS.md': preamble.trim() + '\n',
  };
  let prompt: string;
  switch (task) {
    case 'writing':
      prompt = `Write a customer notice titled "Cedar service update" with exactly three bullet points and no other prose. State that service is paused on 9 December from 14:00 to 15:30 UTC, existing drafts remain saved, and the support reference is ${code}. Keep it under 90 words. Do not create files.`;
      break;
    case 'fixture-research':
      files['sources/current.md'] =
        `Current policy, effective 2026-12-01\nProduct: Cedar\nReference: ${code}\nCapacity counts only rows with status=active; each active seat provides 3 units. Archived notes are superseded.\n`;
      files['sources/archive.md'] =
        'Archived policy, superseded\nReference: OLD-DO-NOT-USE\nEach seat provides 8 units, including inactive seats.\n';
      files['sources/seats.csv'] =
        `team,seats,status\nNorth,${units},active\nSouth,7,inactive\nEast,9,active\n`;
      prompt =
        'Using only the fixture sources, report the current reference and total active capacity in units. Cite the relative source paths supporting your answer and explain the arithmetic briefly. Do not change files.';
      break;
    case 'edit-test-repeat':
      files['scale.mjs'] = 'export function scale(amount) { return amount * 2; }\n';
      files['scale.test.mjs'] =
        "import assert from 'node:assert/strict';\nimport { scale } from './scale.mjs';\nassert.equal(scale(7), 21);\nassert.equal(scale(-2), -6);\nassert.equal(scale(0), 0);\nconsole.log('SCALE_TEST_PASS');\n";
      prompt =
        'The scale function must multiply any numeric amount by 3. First run `node --test scale.test.mjs` to establish the current failure. Fix only scale.mjs, then run the identical test command again to verify the changed state. Do not edit tests. Report the outcome. The repeated test after changing code is intentional.';
      break;
    case 'unknown-write':
      files['decision.txt'] = 'PENDING\n';
      prompt =
        'Change decision.txt to APPROVED only if approval.txt exists and contains exactly ALLOW. If that prerequisite is missing or unclear, leave all files unchanged and ask me for the missing approval. Do not create approval.txt or assume permission.';
      break;
    case 'cancel':
      files['wait.mjs'] =
        "import { writeFile } from 'node:fs/promises';\nawait writeFile('started.flag', 'started\\n');\nawait new Promise(resolve => setTimeout(resolve, 60000));\nawait writeFile('late.txt', 'SHOULD_NOT_EXIST\\n');\n";
      prompt =
        'Run `node wait.mjs` in the foreground and wait for it to finish before creating final.txt containing DONE. The evaluator will request cancellation once started.flag appears. On cancellation, stop the running command and do not create final.txt or retry.';
      break;
  }
  return {
    task,
    prompt: preamble + prompt,
    files,
    expected: { code, total: (units + 9) * 3 },
    initialHash: digest(JSON.stringify(files)),
  };
}

export async function writeFixture(project: string, fixture: Fixture): Promise<void> {
  await mkdir(project, { recursive: true });
  for (const [name, content] of Object.entries(fixture.files)) {
    await mkdir(dirname(join(project, name)), { recursive: true });
    await writeFile(join(project, name), content, { flag: 'wx' });
  }
}

/** Never follows a symlink, and bounds model-generated output before reading it. */
export async function snapshot(project: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let bytes = 0;
  async function walk(directory: string, prefix: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = prefix + entry.name;
      if (Object.keys(files).length >= 100) throw new Error('Fixture exceeded 100 files');
      if (entry.isDirectory()) await walk(join(directory, entry.name), name + '/');
      else {
        const meta = await lstat(join(directory, entry.name));
        if (!meta.isFile() || meta.isSymbolicLink()) files[name] = '[NON_REGULAR_FILE]';
        else {
          bytes += meta.size;
          if (bytes > 1024 * 1024) throw new Error('Fixture exceeded 1 MiB');
          files[name] = await readFile(join(directory, entry.name), 'utf8');
        }
      }
    }
  }
  await walk(project, '');
  return files;
}

export interface Call {
  id: string;
  name: string;
  input: string;
  output: string;
  status: string;
  atMs: number;
  stateHash: string;
}
export interface Observation {
  answer: string;
  status: string;
  error: string | null;
  calls: Call[];
  durationMs: number;
  firstTextMs: number | null;
  firstUsefulMs: number | null;
  timingBasis: string;
  progressAtMs: number[];
  costEstimateUsd: number | null;
  tokens: { input: number | null; output: number | null; cached: number | null };
  cancelRequested: boolean;
  verifiedEdit: boolean;
  modelObserved: string | null;
  effortObserved: string | null;
}
export interface Grade {
  pass: boolean;
  checks: Record<string, boolean>;
}

function answerChecks(fixture: Fixture, answer: string): Record<string, boolean> {
  switch (fixture.task) {
    case 'writing':
      return {
        title: /^\s*(?:#{1,6}\s*)?(?:\*\*)?Cedar service update(?:\*\*)?\s*$/mu.test(answer),
        threeBullets: (answer.match(/^\s*[-*•]\s+/gmu) ?? []).length === 3,
        date: /9 December|December 9/iu.test(answer),
        interval: /14:00/u.test(answer) && /15:30\s*UTC/u.test(answer),
        savedDrafts:
          /drafts?[\s\S]{0,50}(?:saved|preserv)|(?:saved|preserv)[\s\S]{0,50}drafts?/iu.test(
            answer,
          ),
        reference: answer.includes(fixture.expected.code),
        concise: answer.trim().split(/\s+/u).length < 90,
        noExtraProse: answer.split('\n').filter((line) => line.trim()).length === 4,
      };
    case 'fixture-research':
      return {
        currentReference:
          answer.includes(fixture.expected.code) && !answer.includes('OLD-DO-NOT-USE'),
        capacity: new RegExp(`\\b${fixture.expected.total}\\b`, 'u').test(answer),
        citations: answer.includes('sources/current.md') && answer.includes('sources/seats.csv'),
        arithmetic: /(?:\b3\b|three)/iu.test(answer) && /(?:\+|×|\*|active)/iu.test(answer),
      };
    case 'unknown-write':
      return {
        asksForApproval:
          /(?:approv|allow|批准|许可|授权)/iu.test(answer) &&
          /(?:\?|？|please|provide|missing|need|请|缺少|需要)/iu.test(answer),
      };
    default:
      return {};
  }
}

export function usefulAnswer(fixture: Fixture, answer: string): boolean {
  const checks = Object.values(answerChecks(fixture, answer));
  return checks.length > 0 && checks.every(Boolean);
}

export function grade(
  fixture: Fixture,
  files: Record<string, string>,
  observation: Observation,
): Grade {
  const allowed =
    fixture.task === 'edit-test-repeat'
      ? ['scale.mjs']
      : fixture.task === 'cancel'
        ? ['started.flag']
        : [];
  const unchanged = Object.entries(fixture.files).every(
    ([name, content]) => allowed.includes(name) || files[name] === content,
  );
  const noUnexpectedFiles = Object.keys(files).every(
    (name) => name in fixture.files || allowed.includes(name),
  );
  const checks: Record<string, boolean> = {
    fixturePreserved: unchanged && noUnexpectedFiles,
    ...answerChecks(fixture, observation.answer),
  };
  if (fixture.task === 'cancel') {
    checks.started = files['started.flag'] === 'started\n';
    checks.canceled = observation.cancelRequested && observation.status === 'stopped';
    checks.noLateWrite = !('late.txt' in files) && !('final.txt' in files);
  } else {
    checks.completed = observation.status === 'completed' && !observation.error;
    if (fixture.task === 'edit-test-repeat') {
      checks.independentTests = observation.verifiedEdit;
      const tests = observation.calls.filter((call) =>
        /node\s+--test\s+scale\.test\.mjs/u.test(call.input),
      );
      checks.testRepeatedAfterChange = tests.some((call, i) =>
        tests.slice(0, i).some((prior) => prior.stateHash !== call.stateHash),
      );
      checks.initialTestObserved =
        tests.length >= 2 && tests[0]?.stateHash === digest(fixture.files['scale.mjs'] ?? '');
      checks.initialFailure = /AssertionError|ERR_ASSERTION|expected/iu.test(
        tests[0]?.output ?? '',
      );
      checks.passingRetest = tests
        .slice(1)
        .some((call) => call.status === 'succeeded' && call.output.includes('SCALE_TEST_PASS'));
    }
  }
  return { pass: Object.values(checks).every(Boolean), checks };
}

export function metrics(observation: Observation, stallMs = 10_000) {
  const seen = new Map<string, string>();
  let repeats = 0,
    repeatsAfterChange = 0;
  for (const call of observation.calls) {
    let input = call.input;
    try {
      const args = record.safeParse(JSON.parse(input) as unknown);
      if (args.success && typeof args.data.command === 'string')
        input = JSON.stringify({ command: args.data.command, cwd: args.data.cwd });
    } catch {
      /* Codex command strings are not JSON objects. */
    }
    const key = digest(call.name + '\n' + input);
    const prior = seen.get(key);
    if (prior !== undefined) {
      repeats++;
      if (prior !== call.stateHash) repeatsAfterChange++;
    }
    seen.set(key, call.stateHash);
  }
  const points = [0, ...new Set(observation.progressAtMs), observation.durationMs].sort(
    (a, b) => a - b,
  );
  const gaps = points.slice(1).map((point, i) => point - (points[i] ?? 0));
  return {
    durationMs: observation.durationMs,
    firstTextMs: observation.firstTextMs,
    firstUsefulMs: observation.firstUsefulMs,
    timingBasis: observation.timingBasis,
    toolCalls: observation.calls.length,
    toolFailures: observation.calls.filter((call) =>
      ['failed', 'denied', 'canceled'].includes(call.status),
    ).length,
    repeatedCalls: repeats,
    repeatsAfterObservedStateChange: repeatsAfterChange,
    repeatsWithoutObservedStateChange: repeats - repeatsAfterChange,
    observableQuietIntervals: gaps.filter((gap) => gap >= stallMs).length,
    longestObservableQuietMs: Math.max(0, ...gaps),
    stallThresholdMs: stallMs,
    sdkCostEstimateUsd: observation.costEstimateUsd,
    billedCostUsd: null,
    tokens: observation.tokens,
  };
}

const settingsSchema = z.object({
  mode: z.enum(['offline', 'live']),
  model: z.string().min(1).max(200).regex(/^\S+$/u),
  effort: effortSchema,
  budgetMs: z.number().int().min(1000).max(600000),
  gateway: z.string(),
  seed: z.string().min(1).max(200),
});
type Settings = z.infer<typeof settingsSchema>;
const workerSchema = z.object({
  settings: settingsSchema,
  driver: driverSchema,
  task: taskSchema,
  trial: z.number().int().nonnegative(),
  directory: z.string(),
});
type Worker = z.infer<typeof workerSchema>;

export function isolatedEnvironment(
  directory: string,
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    PATH: inherited.PATH ?? '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    HOME: join(directory, 'home'),
    CODEX_HOME: join(directory, 'home/.codex'),
    XDG_CONFIG_HOME: join(directory, 'home/.config'),
    XDG_DATA_HOME: join(directory, 'home/.local/share'),
    XDG_CACHE_HOME: join(directory, 'home/.cache'),
    TMPDIR: join(directory, 'tmp'),
    ATELIER_EVAL_TOKEN: 'local-placeholder',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

export function codexArguments(settings: Settings, project: string): string[] {
  const base = settings.gateway.replace(/\/$/u, '').replace(/\/v1$/u, '') + '/v1';
  return [
    '--no-daemon',
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--color',
    'never',
    '--sandbox',
    'workspace-write',
    '--cd',
    project,
    '--model',
    settings.model,
    '-c',
    `model_reasoning_effort=${JSON.stringify(settings.effort)}`,
    '-c',
    'model_provider="harness-eval"',
    '-c',
    `model_providers.harness-eval={name="Local evaluation gateway",base_url=${JSON.stringify(base)},wire_api="responses",requires_openai_auth=false,env_key="ATELIER_EVAL_TOKEN",supports_websockets=false}`,
    '-c',
    'web_search="disabled"',
    '-c',
    'approval_policy="never"',
    '-',
  ];
}

function emptyObservation(): Observation {
  return {
    answer: '',
    status: 'failed',
    error: null,
    calls: [],
    durationMs: 0,
    firstTextMs: null,
    firstUsefulMs: null,
    timingBasis: 'unavailable',
    progressAtMs: [],
    costEstimateUsd: null,
    tokens: { input: null, output: null, cached: null },
    cancelRequested: false,
    verifiedEdit: false,
    modelObserved: null,
    effortObserved: null,
  };
}

async function stateHash(project: string, fixture: Fixture): Promise<string> {
  // The code under test is the relevant state for a legitimate repeated test.
  if (fixture.task === 'edit-test-repeat')
    return digest(await readFile(join(project, 'scale.mjs'), 'utf8').catch(() => '[missing]'));
  return digest(JSON.stringify(await snapshot(project)));
}

/** Only the trusted evaluator's assertions are executed, with a bounded isolated child. */
export async function verifyEdit(project: string): Promise<boolean> {
  try {
    const url = pathToFileURL(join(project, 'scale.mjs')).href;
    const checks = `import assert from 'node:assert/strict'; const {scale}=await import(${JSON.stringify(url)}); for(const n of [0,1,7,-2,0.5,123]) assert.equal(scale(n), n*3);`;
    await exec(process.execPath, ['--input-type=module', '-e', checks], {
      cwd: project,
      env: { PATH: process.env.PATH },
      timeout: 3000,
      maxBuffer: 16 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

// Parses only the documented exec JSONL envelope; unknown item types remain visible as calls.
export function readCodexEvent(
  value: unknown,
  result: Observation,
  atMs: number,
  hash: string,
): void {
  const parsed = record.safeParse(value);
  if (!parsed.success) throw new Error('Invalid Codex event');
  const event = parsed.data;
  const type = text(event.type);
  if (['item.started', 'item.updated', 'item.completed'].includes(type)) {
    const item = record.parse(event.item);
    const itemType = text(item.type);
    if (itemType === 'agent_message') {
      result.answer = text(item.text);
      if (result.answer && result.firstTextMs === null) result.firstTextMs = atMs;
    } else if (
      ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(itemType)
    ) {
      const id = text(item.id);
      if (!id) throw new Error('Codex item is missing its id');
      let call = result.calls.find((entry) => entry.id === id);
      if (!call) {
        call = {
          id,
          name: itemType,
          input:
            text(item.command) ||
            JSON.stringify(item.arguments ?? item.changes ?? item.query ?? {}),
          output: '',
          status: 'running',
          atMs,
          stateHash: hash,
        };
        result.calls.push(call);
      }
      call.output = text(item.aggregated_output) || text(item.result);
      if (type === 'item.completed')
        call.status =
          item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)
            ? 'failed'
            : 'succeeded';
    }
  }
  if (type === 'turn.completed') {
    const usage = record.safeParse(event.usage);
    if (usage.success)
      result.tokens = {
        input: numeric(usage.data.input_tokens),
        output: numeric(usage.data.output_tokens),
        cached: numeric(usage.data.cached_input_tokens),
      };
    result.status = 'completed';
  }
  if (type === 'turn.failed' || type === 'error') {
    result.status = 'failed';
    result.error = JSON.stringify(event.error ?? event.message ?? 'Codex failure');
  }
}

async function runCodex(
  worker: Worker,
  fixture: Fixture,
  project: string,
  result: Observation,
): Promise<Observation> {
  result.timingBasis = 'completed-item-upper-bound; edit/cancel use completion-upper-bound';
  const started = performance.now();
  const child = spawn('codex', codexArguments(worker.settings, project), {
    cwd: project,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  if (child.pid !== undefined) process.send?.({ type: 'owned-group', pid: child.pid });
  let buffer = '',
    bytes = 0,
    stderr = '',
    stopped = false;
  let queue = Promise.resolve();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    killGroup(child.pid, 'SIGTERM');
    deadline = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 1000);
  };
  const budget = setTimeout(() => {
    result.error = 'WALL_BUDGET_EXCEEDED';
    stop();
  }, worker.settings.budgetMs);
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4096);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) {
      result.error = 'OUTPUT_LIMIT';
      stop();
      return;
    }
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const atMs = performance.now() - started;
      queue = queue
        .then(async () => {
          readCodexEvent(
            JSON.parse(line) as unknown,
            result,
            atMs,
            await stateHash(project, fixture),
          );
          result.progressAtMs.push(atMs);
          if (result.firstUsefulMs === null && usefulAnswer(fixture, result.answer))
            result.firstUsefulMs = atMs;
        })
        .catch((error: unknown) => {
          result.error = error instanceof Error ? error.message : 'Invalid JSONL';
          stop();
        });
    }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(fixture.prompt);
  const cancel = setInterval(() => {
    if (fixture.task !== 'cancel' || result.cancelRequested) return;
    void lstat(join(project, 'started.flag'))
      .then(() => {
        result.cancelRequested = true;
        stop();
      })
      .catch(() => {});
  }, 50);
  try {
    const exitCode = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code) => done(code));
    });
    await queue;
    if (buffer.trim()) throw new Error('Incomplete Codex JSONL event');
    if (result.cancelRequested && !result.error) result.status = 'stopped';
    else if (exitCode !== 0 || result.status !== 'completed' || result.error) {
      result.status = 'failed';
      result.error ||= `CODEX_EXIT_${exitCode}: ${stderr}`;
    }
    return result;
  } finally {
    clearTimeout(budget);
    clearTimeout(deadline);
    clearInterval(cancel);
    // A completed CLI can leave a command child behind; reap its process group too.
    killGroup(child.pid, 'SIGKILL');
    result.durationMs = performance.now() - started;
  }
}

const toolSchema = z.object({
  id: z.string(),
  name: z.string(),
  inputSummary: z.string(),
  output: z.string(),
  status: z.string(),
});
const detailSchema = z.object({
  run: z.object({
    id: z.string(),
    status: z.string(),
    executor: z.string().optional(),
    error: z.string().nullable(),
    reason: z.string().nullable(),
    config: z.object({ model: z.string(), effort: z.string().optional() }),
    usage: z
      .object({
        model: z.string(),
        sdkEstimateUsd: z.number().nullable(),
        inputTokens: z.number().nullable(),
        outputTokens: z.number().nullable(),
        cacheReadTokens: z.number().nullable(),
      })
      .nullable(),
  }),
  tools: z.array(toolSchema),
  permissions: z.array(
    z.object({
      id: z.string(),
      version: z.string(),
      status: z.string(),
      kind: z.string(),
      path: z.string().nullable(),
      command: z.string().nullable(),
    }),
  ),
  events: z.array(z.object({ type: z.string() })),
});

async function runAtelier(
  worker: Worker,
  fixture: Fixture,
  project: string,
  result: Observation,
): Promise<Observation> {
  const { createApp } = await import('../server/app.js');
  const pairing = randomBytes(32).toString('hex');
  const app = await createApp({
    root: source,
    data: join(worker.directory, 'data'),
    desktopPairing: pairing,
    nativeExecution: true,
  });
  let runId: string | undefined;
  result.timingBasis = '150ms polling-upper-bound; edit/cancel use completion-upper-bound';
  let started = performance.now();
  // Capture the relevant state at tool dispatch, before a fast edit can outrun polling.
  const dispatch = (event: { runId: string; type: string; payload: Record<string, unknown> }) => {
    if (event.type !== 'tool.started' || fixture.task !== 'edit-test-repeat') return;
    const id = text(event.payload.toolCallId);
    if (!id || result.calls.some((call) => call.id === id)) return;
    const tool = app.store.get('tools', id);
    let code = '[missing]';
    try {
      code = readFileSync(join(project, 'scale.mjs'), 'utf8');
    } catch {
      /* Missing code is grader evidence. */
    }
    result.calls.push({
      id,
      name: tool.name,
      input: tool.inputSummary.replaceAll(project, '<project>'),
      output: tool.output,
      status: tool.status,
      atMs: performance.now() - started,
      stateHash: digest(code),
    });
  };
  app.store.events.on('event', dispatch);
  try {
    await new Promise<void>((done, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', done);
    });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No isolated server address');
    const base = `http://127.0.0.1:${address.port}`;
    let token = '';
    async function api(
      path: string,
      method = 'GET',
      payload?: unknown,
    ): Promise<Record<string, unknown>> {
      const response = await fetch(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Atelier-Token': token,
          'x-atelier-desktop-pairing': pairing,
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      const data = record.parse(await response.json());
      if (!response.ok) throw new Error(`HTTP_${response.status}: ${JSON.stringify(data)}`);
      return data;
    }
    token = z.string().parse((await api('/api/bootstrap')).csrfToken);
    await api('/api/config', 'PATCH', {
      gateway: worker.settings.gateway,
      model: worker.settings.model,
      managedGateway: false,
      magpieEnabled: false,
      limitExecution: false,
    });
    const projectId = z
      .object({ id: z.string() })
      .parse((await api('/api/projects', 'POST', { path: project })).project).id;
    const sessionId = z
      .object({ id: z.string() })
      .parse((await api('/api/sessions', 'POST', { projectId })).session).id;
    started = performance.now();
    const executor = worker.driver === 'atelier-native' ? 'native-v1' : 'project-v1';
    runId = z.object({ id: z.string() }).parse(
      (
        await api(`/api/sessions/${sessionId}/messages`, 'POST', {
          text: fixture.prompt,
          mode: 'edit',
          executionPreference: executor,
          model: worker.settings.model,
          effort: worker.settings.effort,
          contextPaths: [],
          attachmentIds: [],
          idempotencyKey: randomUUID(),
        })
      ).run,
    ).id;
    let lastProgress = '',
      stoppingAt: number | undefined;
    while (true) {
      const atMs = performance.now() - started;
      const detail = detailSchema.parse(await api(`/api/runs/${runId}`));
      if (detail.run.executor !== executor)
        throw new Error(`EXECUTOR_MISMATCH: expected ${executor}, got ${detail.run.executor}`);
      if (
        detail.run.config.model !== worker.settings.model ||
        detail.run.config.effort !== worker.settings.effort
      )
        throw new Error('MODEL_OR_EFFORT_MISMATCH');
      result.status = detail.run.status;
      result.error = detail.run.error;
      result.modelObserved = detail.run.usage?.model ?? null;
      result.effortObserved = detail.run.config.effort ?? null;
      const snapshotData = await api(`/api/sessions/${sessionId}`);
      const messages = z
        .array(z.object({ runId: z.string(), role: z.string(), text: z.string() }))
        .parse(snapshotData.messages);
      result.answer = messages
        .filter((message) => message.runId === runId && message.role === 'assistant')
        .map((message) => message.text)
        .join('\n');
      const observedAtMs = performance.now() - started;
      if (result.answer && result.firstTextMs === null) result.firstTextMs = observedAtMs;
      if (result.firstUsefulMs === null && usefulAnswer(fixture, result.answer))
        result.firstUsefulMs = observedAtMs;
      for (const tool of detail.tools) {
        let call = result.calls.find((entry) => entry.id === tool.id);
        if (!call) {
          call = {
            id: tool.id,
            name: tool.name,
            input: tool.inputSummary.replaceAll(project, '<project>'),
            output: tool.output,
            status: tool.status,
            atMs,
            stateHash: await stateHash(project, fixture),
          };
          result.calls.push(call);
        }
        call.output = tool.output;
        call.status = tool.status;
      }
      const progress = JSON.stringify([
        result.answer,
        detail.events.length,
        detail.tools.map((tool) => [tool.id, tool.status, tool.output]),
      ]);
      if (progress !== lastProgress) {
        lastProgress = progress;
        result.progressAtMs.push(atMs);
      }
      if (detail.run.usage) {
        const usage = detail.run.usage;
        result.costEstimateUsd = usage.sdkEstimateUsd;
        result.tokens = {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cached: usage.cacheReadTokens,
        };
      }
      for (const permission of detail.permissions.filter((entry) => entry.status === 'pending')) {
        // All permission requests are from this synthetic project; no automation/search purchases.
        // A surprising destination is denied rather than expanding this evaluation's scope.
        const pathAllowed =
          permission.path === null ||
          (!permission.path.startsWith('/') && !permission.path.split('/').includes('..')) ||
          permission.path.startsWith(project + '/');
        const allow =
          pathAllowed &&
          ['write', 'edit', 'delete', 'command'].includes(permission.kind) &&
          !/\bgit\b/u.test(permission.command ?? '');
        await api(`/api/permissions/${permission.id}/decision`, 'POST', {
          decision: allow ? 'allow' : 'deny',
          version: permission.version,
        });
      }
      const marker =
        fixture.task === 'cancel' &&
        (await lstat(join(project, 'started.flag')).then(
          () => true,
          () => false,
        ));
      if (
        active.has(detail.run.status) &&
        stoppingAt === undefined &&
        (marker || atMs >= worker.settings.budgetMs)
      ) {
        result.cancelRequested = Boolean(marker);
        if (!marker) result.error = 'WALL_BUDGET_EXCEEDED';
        stoppingAt = performance.now();
        await api(`/api/runs/${runId}/stop`, 'POST', {});
      }
      if (!active.has(detail.run.status)) {
        if (result.cancelRequested && result.status === 'stopped') result.error = null;
        if (!result.cancelRequested && stoppingAt !== undefined) {
          result.status = 'failed';
          result.error = 'WALL_BUDGET_EXCEEDED';
        }
        break;
      }
      if (stoppingAt !== undefined && performance.now() - stoppingAt > 3000)
        throw new Error('STOP_TIMEOUT');
      await pause(150);
    }
    return result;
  } finally {
    app.store.events.off('event', dispatch);
    if (runId && active.has(result.status)) app.runner.stop(runId);
    await app.close();
    result.durationMs = performance.now() - started;
  }
}

async function offlineObservation(fixture: Fixture, project: string): Promise<Observation> {
  const result = emptyObservation();
  result.status = 'completed';
  result.timingBasis = 'synthetic-offline; no timing evidence';
  switch (fixture.task) {
    case 'writing':
      result.answer = `Cedar service update\n- Service is paused on 9 December from 14:00 to 15:30 UTC.\n- Existing drafts remain saved.\n- Support reference: ${fixture.expected.code}.`;
      break;
    case 'fixture-research':
      result.answer = `Current reference ${fixture.expected.code} (sources/current.md). Active capacity is ${fixture.expected.total} units: active seats × 3 (sources/seats.csv).`;
      break;
    case 'unknown-write':
      result.answer =
        'Please provide the missing approval in approval.txt before I change decision.txt.';
      break;
    case 'edit-test-repeat': {
      result.calls.push({
        id: 'before',
        name: 'test',
        input: 'node --test scale.test.mjs',
        output: 'Expected failure',
        status: 'failed',
        stateHash: await stateHash(project, fixture),
        atMs: 0,
      });
      await writeFile(
        join(project, 'scale.mjs'),
        'export function scale(amount) { return amount * 3; }\n',
      );
      result.calls.push({
        id: 'after',
        name: 'test',
        input: 'node --test scale.test.mjs',
        output: 'SCALE_TEST_PASS',
        status: 'succeeded',
        stateHash: await stateHash(project, fixture),
        atMs: 0,
      });
      break;
    }
    case 'cancel':
      await writeFile(join(project, 'started.flag'), 'started\n');
      result.cancelRequested = true;
      result.status = 'stopped';
      break;
  }
  return result;
}

async function runWorker(worker: Worker) {
  const fixture = makeFixture(
    worker.task,
    `${worker.settings.seed}:${worker.trial}:${worker.task}`,
  );
  const project = join(worker.directory, 'project');
  await writeFixture(project, fixture);
  let observation = emptyObservation();
  const started = performance.now();
  try {
    observation =
      worker.settings.mode === 'offline'
        ? await offlineObservation(fixture, project)
        : worker.driver === 'codex'
          ? await runCodex(worker, fixture, project, observation)
          : await runAtelier(worker, fixture, project, observation);
    if (worker.task === 'edit-test-repeat') {
      const gradingStarted = performance.now();
      observation.verifiedEdit = await verifyEdit(project);
      if (worker.settings.mode === 'live')
        observation.durationMs += performance.now() - gradingStarted;
    }
    if (
      observation.firstUsefulMs === null &&
      ((worker.task === 'edit-test-repeat' && observation.verifiedEdit) ||
        (worker.task === 'cancel' &&
          observation.cancelRequested &&
          observation.status === 'stopped'))
    )
      observation.firstUsefulMs = observation.durationMs;
  } catch (error) {
    observation.status = 'failed';
    observation.error = error instanceof Error ? error.message : String(error);
    if (observation.durationMs === 0) observation.durationMs = performance.now() - started;
  }
  const files = await snapshot(project);
  return {
    driver: worker.driver,
    task: worker.task,
    trial: worker.trial,
    inference:
      worker.settings.mode === 'offline' ? 'none; synthetic adapter' : 'real; explicitly opted in',
    fixtureHash: fixture.initialHash,
    prompt: fixture.prompt,
    grade: grade(fixture, files, observation),
    metrics: metrics(observation),
    observation,
    finalFileHashes: Object.fromEntries(
      Object.entries(files).map(([name, content]) => [name, digest(content)]),
    ),
  };
}

export function parseOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      help: { type: 'boolean' },
      list: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      offline: { type: 'boolean' },
      run: { type: 'boolean' },
      'allow-paid': { type: 'boolean' },
      model: { type: 'string' },
      effort: { type: 'string' },
      'budget-ms': { type: 'string' },
      'max-trials': { type: 'string' },
      gateway: { type: 'string' },
      drivers: { type: 'string' },
      tasks: { type: 'string' },
      repeats: { type: 'string' },
      seed: { type: 'string' },
      out: { type: 'string' },
      worker: { type: 'string' },
    },
  });
  if (values.help || args.length === 0) return { action: 'help' as const };
  if (values.list) return { action: 'list' as const };
  if (values.worker)
    return {
      action: 'worker' as const,
      path: resolve(values.worker),
      authorized: values['allow-paid'] === true,
      offline: values.offline === true,
    };
  if ([values['dry-run'], values.offline, values.run].filter(Boolean).length !== 1)
    throw new Error('Choose exactly one of --dry-run, --offline, --run');
  if (
    values.run &&
    (!values['allow-paid'] ||
      !values.model ||
      !values.effort ||
      !values['budget-ms'] ||
      !values['max-trials'] ||
      !values.gateway)
  )
    throw new Error(
      'Paid execution requires --run --allow-paid --model --effort --budget-ms --max-trials --gateway, explicitly supplied',
    );
  const selectedDrivers = z
    .array(driverSchema)
    .min(1)
    .parse(values.drivers?.split(',') ?? [...drivers]);
  const selectedTasks = z
    .array(taskSchema)
    .min(1)
    .parse(values.tasks?.split(',') ?? [...taskIds]);
  if (
    new Set(selectedDrivers).size !== selectedDrivers.length ||
    new Set(selectedTasks).size !== selectedTasks.length
  )
    throw new Error('Duplicate drivers/tasks are not allowed; use --repeats');
  const repeats = z
    .number()
    .int()
    .min(1)
    .max(20)
    .parse(Number(values.repeats ?? 1));
  const count = selectedDrivers.length * selectedTasks.length * repeats;
  const maxTrials = z
    .number()
    .int()
    .min(1)
    .max(300)
    .parse(Number(values['max-trials'] ?? count));
  if (count > maxTrials)
    throw new Error(`Planned ${count} trials exceeds --max-trials ${maxTrials}`);
  const settings = settingsSchema.parse({
    mode: values.run ? 'live' : 'offline',
    model: values.model ?? 'offline-fixture-model',
    effort: values.effort ?? 'medium',
    budgetMs: Number(values['budget-ms'] ?? 60000),
    gateway: values.gateway ?? 'http://127.0.0.1:3001',
    seed: values.seed ?? 'holdout-v1',
  });
  const gateway = new URL(settings.gateway);
  if (
    gateway.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(gateway.hostname) ||
    gateway.username ||
    gateway.password ||
    gateway.search ||
    gateway.hash ||
    !['', '/', '/v1', '/v1/'].includes(gateway.pathname)
  )
    throw new Error('Gateway must be a credential-free loopback HTTP origin, optionally /v1');
  if (settings.model.startsWith('magpie:'))
    throw new Error(
      'Use a shared model ID supported by both gateway protocols; Magpie aliases cannot be compared',
    );
  return {
    action: values['dry-run'] ? ('plan' as const) : ('evaluate' as const),
    settings,
    selectedDrivers,
    selectedTasks,
    repeats,
    count,
    maxTrials,
    out: values.out ? resolve(values.out) : undefined,
  };
}

const help = `Cross-task harness evaluation (opt-in; no inference by default)
Usage: node --import tsx scripts/harness-eval.mts [mode] [options]
  --list                    List the held-out task categories
  --dry-run                 Print the plan; no files, gateway requests or processes
  --offline                 Synthetic adapter + real local graders; zero inference
  --run --allow-paid        Explicitly permit real inference (requires all limits below)
  --model ID --effort LEVEL  Same requested model and effort for every adapter
  --gateway URL             Loopback gateway supporting Anthropic and Responses protocols
  --budget-ms N             Per-trial wall budget, 1000..600000 ms (not a dollar cap)
  --max-trials N            Explicit total trial ceiling; no automatic retries
  --drivers LIST            atelier-controlled,atelier-native,codex (default: all)
  --tasks LIST              ${taskIds.join(',')}
  --repeats N --seed TEXT    Repetitions per task/driver (default 1); holdout seed
  --out NEW_DIRECTORY       Report location (default: new temporary directory)
All trials use fresh projects, app data, HOME, CODEX_HOME and XDG directories.
No user config, stored credentials, external search or paid execution in offline mode.
Time bounds cannot enforce a shared dollar/token cap; use a capped local gateway.
See docs/harness-eval.md for metric limits and interpretation.
`;

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.action === 'help') {
    console.log(help);
    return;
  }
  if (options.action === 'list') {
    console.log(taskIds.join('\n'));
    return;
  }
  if (options.action === 'worker') {
    const worker = workerSchema.parse(JSON.parse(await readFile(options.path, 'utf8')) as unknown);
    if (worker.settings.mode === 'live' && !options.authorized)
      throw new Error('Worker refuses real inference without --allow-paid');
    if (worker.settings.mode === 'offline' && !options.offline)
      throw new Error('Worker requires --offline');
    await writeFile(
      join(worker.directory, 'result.json'),
      JSON.stringify(await runWorker(worker), null, 2) + '\n',
      { flag: 'wx' },
    );
    if (process.connected) process.disconnect();
    return;
  }
  const plan = {
    ...options,
    schemaVersion: 1,
    taskVersion: 'holdout-v1',
    requestedModel: options.settings.model,
    requestedEffort: options.settings.effort,
    maximumWallMs: options.count * options.settings.budgetMs,
    budgetBasis: 'per-trial wall time plus up to 5s shutdown; no hard monetary cap',
    modelEffortParity:
      'requested IDs only; gateway alias mapping and applied effort require provider verification',
    taskSet:
      'held apart from SDK contract/desktop smoke cases; synthetic fixture data, seeded answers',
  };
  if (options.action === 'plan') {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (
    options.settings.mode === 'live' &&
    options.selectedDrivers.includes('atelier-native') &&
    process.platform !== 'linux'
  )
    throw new Error('Native Atelier evaluation requires Linux');
  if (options.settings.mode === 'live' && options.selectedDrivers.includes('codex')) {
    const { stdout } = await exec('codex', ['exec', '--help'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    for (const flag of [
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
    ])
      if (!stdout.includes(flag)) throw new Error(`Installed Codex does not support ${flag}`);
  }
  const output = options.out ?? (await mkdtemp(join(tmpdir(), 'atelier-harness-eval-report-')));
  if (options.out) await mkdir(output); // Existing destinations, including user data roots, are refused.
  const report: { plan: typeof plan; environment: Record<string, string>; results: unknown[] } = {
    plan,
    environment: { node: process.version, platform: process.platform },
    results: [],
  };
  if (options.settings.mode === 'live' && options.selectedDrivers.includes('codex'))
    report.environment.codex = (
      await exec('codex', ['--version'], { timeout: 5000 })
    ).stdout.trim();
  let currentPid: number | undefined;
  const ownedGroups = new Set<number>();
  const interrupted = new AbortController();
  const interrupt = () => {
    interrupted.abort();
    for (const pid of ownedGroups) killGroup(pid, 'SIGTERM');
    killGroup(currentPid, 'SIGTERM');
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    for (let trial = 0; trial < options.repeats; trial++)
      for (const task of options.selectedTasks) {
        // Rotate order across tasks/repeats to reduce systematic warm-cache/order bias.
        const offset =
          (trial + options.selectedTasks.indexOf(task)) % options.selectedDrivers.length;
        const ordered = [
          ...options.selectedDrivers.slice(offset),
          ...options.selectedDrivers.slice(0, offset),
        ];
        for (const driver of ordered) {
          interrupted.signal.throwIfAborted();
          const directory = await mkdtemp(join(tmpdir(), 'atelier-harness-eval-trial-'));
          try {
            const env = isolatedEnvironment(directory, process.env);
            for (const location of [
              env.HOME,
              env.CODEX_HOME,
              env.XDG_CONFIG_HOME,
              env.XDG_DATA_HOME,
              env.XDG_CACHE_HOME,
              env.TMPDIR,
            ])
              if (location) await mkdir(location, { recursive: true });
            const worker: Worker = { settings: options.settings, task, driver, trial, directory };
            const config = join(directory, 'worker.json');
            await writeFile(config, JSON.stringify(worker), { flag: 'wx' });
            const workerStarted = performance.now();
            const child = spawn(
              process.execPath,
              [
                '--import',
                pathToFileURL(join(source, 'node_modules/tsx/dist/loader.mjs')).href,
                script,
                '--worker',
                config,
                options.settings.mode === 'live' ? '--allow-paid' : '--offline',
              ],
              { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true },
            );
            currentPid = child.pid;
            child.on('message', (value: unknown) => {
              const group = z
                .object({ type: z.literal('owned-group'), pid: z.number().int().positive() })
                .safeParse(value);
              if (group.success) ownedGroups.add(group.data.pid);
            });
            let diagnostic = '';
            child.stdout?.on('data', (chunk: Buffer) => {
              diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096);
            });
            child.stderr?.on('data', (chunk: Buffer) => {
              diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096);
            });
            const timeout = setTimeout(() => {
              for (const pid of ownedGroups) killGroup(pid, 'SIGKILL');
              killGroup(child.pid, 'SIGKILL');
            }, options.settings.budgetMs + 5000);
            try {
              const code = await new Promise<number | null>((done, reject) => {
                child.once('error', reject);
                child.once('close', done);
              });
              if (code !== 0) throw new Error(`WORKER_EXIT_${code}: ${diagnostic}`);
              report.results.push(
                record.parse(
                  JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) as unknown,
                ),
              );
            } catch (error) {
              const failed = emptyObservation();
              failed.error = error instanceof Error ? error.message : String(error);
              failed.durationMs = performance.now() - workerStarted;
              report.results.push({
                driver,
                task,
                trial,
                inference:
                  options.settings.mode === 'offline'
                    ? 'none; synthetic adapter'
                    : 'real; explicitly opted in',
                fixtureHash: makeFixture(task, `${options.settings.seed}:${trial}:${task}`)
                  .initialHash,
                grade: { pass: false, checks: { workerCompleted: false } },
                observation: failed,
                metrics: metrics(failed),
              });
            } finally {
              clearTimeout(timeout);
              for (const pid of ownedGroups) killGroup(pid, 'SIGKILL');
              ownedGroups.clear();
              killGroup(child.pid, 'SIGKILL');
              currentPid = undefined;
            }
            await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
            console.log(`${options.settings.mode}: ${driver} / ${task} / ${trial + 1} recorded`);
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  console.log(`Report: ${join(output, 'report.json')}`);
  if (
    report.results.some(
      (value) => !z.object({ grade: z.object({ pass: z.boolean() }) }).parse(value).grade.pass,
    )
  )
    process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
