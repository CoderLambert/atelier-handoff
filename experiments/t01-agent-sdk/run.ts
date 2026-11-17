import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, lstat, writeFile } from 'node:fs/promises';
import { tmpdir, release, arch } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTick } from 'node:timers/promises';
import { query, type Options, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalGate, ToolPolicy, hash, type Emit, type Operation } from './policy.js';
import { EventObserver, MessageInput, evidenceWriter } from './events.js';

const directory = fileURLToPath(new URL('.', import.meta.url));
const gateway = 'http://127.0.0.1:3001';
const model = 'gpt-6.1-sol';
const sdkVersion = '0.3.326';
const maximumInputs = 8;
const ledgerPath = join(directory, '.authorization-ledger.json');
const secretValues = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].map(key => process.env[key]).filter((value): value is string => !!value);

function safeError(error: unknown): string {
  let text = error instanceof Error ? `${error.name}: ${error.message}` : 'UNKNOWN_ERROR';
  for (const value of secretValues) text = text.split(value).join('[REDACTED]');
  return text.replace(/(?:Bearer|sk-ant-|sk-proj-)[^\s"']+/gi, '[REDACTED]').slice(0, 500);
}
function childEnvironment(state: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) if (process.env[key]) env[key] = process.env[key];
  return {
    ...env, ANTHROPIC_BASE_URL: gateway, ANTHROPIC_AUTH_TOKEN: 'local-placeholder', ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CONFIG_DIR: state, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
  };
}
async function preflight() {
  assert.equal(process.versions.node.split('.')[0], '24', 'Use the documented Node 24 runtime.');
  const installed = JSON.parse(await readFile(join(directory, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'));
  assert.equal(installed.version, sdkVersion, 'SDK_VERSION_CHANGED');
  const response = await fetch(gateway + '/health', { signal: AbortSignal.timeout(4000) });
  assert.equal(response.status, 200, 'SHUNT_HEALTH_HTTP');
  const health = await response.json() as { status?: string; version?: string };
  assert.equal(health.status, 'ok', 'SHUNT_UNHEALTHY');
  return { at: new Date().toISOString(), node: process.version, npm: process.env.npm_config_user_agent ?? null, os: process.platform, arch: arch(), kernel: release(), sdk: installed.version, bundledCliDeclared: installed.claudeCodeVersion, shunt: health.version, gateway, configuredModel: model, auth: 'Shunt-managed chatgpt-plan; local placeholder only in SDK', inferencePerformed: false };
}

interface Ledger {
  authorization: string; inputs: number; queries: number; sdkEstimatedIncrementUsd: number;
  sessionCosts: Record<string, number>; attempts: { name: string; batch: string; reservedInputs: number; at: string }[];
}
function loadLedger(): Ledger {
  return existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { authorization: '2026-11-18-user-authorized-T01-Shunt', inputs: 0, queries: 0, sdkEstimatedIncrementUsd: 0, sessionCosts: {}, attempts: [] };
}
function reserve(name: string, inputs: number, batch: string): void {
  const ledger = loadLedger();
  if (ledger.inputs + inputs > maximumInputs || ledger.queries >= 8 || ledger.sdkEstimatedIncrementUsd >= 4) throw new Error('AUTHORIZED_BATCH_EXHAUSTED');
  ledger.inputs += inputs; ledger.queries++;
  ledger.attempts.push({ name, batch, reservedInputs: inputs, at: new Date().toISOString() });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
}
function account(results: SDKResultMessage[]): void {
  const ledger = loadLedger();
  for (const result of results) if (Number.isFinite(result.total_cost_usd)) {
    const previous = ledger.sessionCosts[result.session_id] ?? 0;
    ledger.sdkEstimatedIncrementUsd += Math.max(0, result.total_cost_usd - previous);
    ledger.sessionCosts[result.session_id] = Math.max(previous, result.total_cost_usd);
  }
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
}
async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('CLEANUP_TIMEOUT')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function inventory(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const walk = async (relative: string) => {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const part = relative ? `${relative}/${name}` : name;
      const path = join(root, part); const stat = await lstat(path);
      if (stat.isSymbolicLink()) entries[part] = 'SYMLINK';
      else if (stat.isDirectory()) { entries[part + '/'] = 'DIRECTORY'; await walk(part); }
      else if (stat.isFile()) entries[part] = hash(await readFile(path));
      else entries[part] = 'SPECIAL';
    }
  };
  await walk(''); return entries;
}

interface SessionConfig {
  name: string; workspace: string; state: string; raw: string; tools: string[]; emit: Emit;
  resume?: string;
  decide?: (operation: Operation, gate: ApprovalGate) => void | Promise<void>;
  onMessage?: (message: SDKMessage, session: Session) => void;
}
class Session {
  readonly cancellation = new AbortController();
  readonly input = new MessageInput<SDKUserMessage>();
  readonly observer: EventObserver;
  readonly policy: ToolPolicy;
  readonly connection: ReturnType<typeof query>;
  readonly reading: Promise<void>;
  child?: ChildProcessWithoutNullStreams;
  exited?: { code: number | null; signal: string | null; at: string };
  private exitPromise?: Promise<void>;
  private active?: { resolve(value: SDKResultMessage): void; reject(error: Error): void };
  private closing = false;
  private timer: ReturnType<typeof setTimeout>;
  timedOut = false;
  readError?: string;
  cancellationReason?: string;
  constructor(readonly config: SessionConfig) {
    this.observer = new EventObserver(config.emit);
    this.policy = new ToolPolicy(config.workspace, config.tools, this.cancellation.signal, config.emit, config.decide ?? ((_operation, gate) => { gate.settle('denied'); }));
    const options: Options = {
      cwd: config.workspace, model, tools: config.tools, allowedTools: [],
      permissionMode: 'default', settingSources: [], mcpServers: {}, plugins: [],
      persistSession: true, includePartialMessages: true, maxTurns: 6, maxBudgetUsd: 0.5,
      abortController: this.cancellation, env: childEnvironment(config.state),
      ...(config.resume ? { resume: config.resume } : { sessionId: randomUUID() }),
      systemPrompt: 'You are running a small filesystem capability test. Follow the requested operation exactly, use only supplied tools, and respond concisely. Never access paths outside the working directory. A denied tool must not be retried or replaced with another operation. Do not create plans, background tasks, or subagents.',
      hooks: {
        PreToolUse: [{ hooks: [this.policy.preToolUse], onFailure: 'block', timeout: 25 }],
        PostToolUse: [{ hooks: [async (event) => { if (event.hook_event_name === 'PostToolUse') config.emit('tool.executed', { id: event.tool_use_id, tool: event.tool_name }); return {}; }] }],
        PostToolUseFailure: [{ hooks: [async (event) => { if (event.hook_event_name === 'PostToolUseFailure') config.emit('tool.failed', { id: event.tool_use_id, tool: event.tool_name }); return {}; }] }],
      },
      canUseTool: this.policy.canUseTool,
      spawnClaudeCodeProcess: (params) => {
        const child = spawn(params.command, params.args, { cwd: params.cwd, env: params.env, signal: params.signal, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;
        child.stderr.pipe(createWriteStream(join(config.raw, config.name + '.stderr'), { mode: 0o600 }));
        config.emit('process.spawned', { pid: child.pid, executable: basename(params.command) });
        this.exitPromise = new Promise(resolve => {
          child.once('exit', (code, signal) => { this.exited = { code, signal, at: new Date().toISOString() }; config.emit('process.exited', this.exited); resolve(); });
          child.once('error', error => { config.emit('process.error', { name: error.name, code: (error as NodeJS.ErrnoException).code ?? null }); if (!child.pid) resolve(); });
        });
        return child;
      },
    };
    this.connection = query({ prompt: this.input, options });
    this.timer = setTimeout(() => { this.timedOut = true; this.abort('120-second-deadline'); }, 120_000);
    this.reading = this.read();
  }
  private async read() {
    try {
      for await (const message of this.connection) {
        this.observer.observe(message);
        if (message.type === 'system' && message.subtype === 'init') {
          assert.deepEqual([...message.tools].sort(), [...this.config.tools].sort(), 'UNEXPECTED_TOOL_SET');
          assert.equal(message.mcp_servers.length, 0, 'UNEXPECTED_MCP');
          assert.equal(message.model, model, 'UNEXPECTED_MODEL');
          if (this.config.resume) assert.equal(message.session_id, this.config.resume, 'RESUME_ID_CHANGED');
        }
        this.config.onMessage?.(message, this);
        if (message.type === 'result') {
          const active = this.active; this.active = undefined; active?.resolve(message);
        }
      }
      if (this.active) throw new Error('EOF_WITHOUT_RESULT');
    } catch (error) {
      this.readError = safeError(error);
      this.config.emit('reader.ended', { canceled: this.cancellation.signal.aborted, closing: this.closing, error: this.readError });
      this.active?.reject(new Error(this.cancellation.signal.aborted ? 'QUERY_CANCELED' : this.readError)); this.active = undefined;
      this.input.end(); this.connection.close();
    }
  }
  run(prompt: string): Promise<SDKResultMessage> {
    if (this.active || this.closing || this.cancellation.signal.aborted || this.readError) throw new Error('SESSION_NOT_READY');
    return new Promise((resolve, reject) => {
      this.active = { resolve, reject };
      this.config.emit('input.sent', { characters: prompt.length, hash: hash(prompt) });
      this.input.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, uuid: randomUUID() });
    });
  }
  abort(reason: string) {
    this.cancellationReason = reason;
    this.config.emit('cancel.requested', { reason });
    this.cancellation.abort(); this.input.end();
  }
  async close() {
    this.closing = true; clearTimeout(this.timer); this.input.end(); this.connection.close();
    try {
      await deadline(this.reading, 10_000);
      if (this.exitPromise) await deadline(this.exitPromise, 10_000);
    } catch (error) {
      if (this.child && !this.exited) { this.config.emit('process.forced_cleanup', {}); this.child.kill('SIGKILL'); await deadline(this.exitPromise!, 3000); }
      throw error;
    }
    assert.ok(this.exited, 'SDK_PROCESS_EXIT_NOT_OBSERVED');
  }
}
function success(result: SDKResultMessage) {
  assert.equal(result.subtype, 'success', 'EXPECTED_SUCCESS_RESULT');
  assert.equal(result.is_error, false, 'RESULT_IS_ERROR');
  assert.equal(result.terminal_reason ?? 'completed', 'completed', 'TURN_NOT_COMPLETED');
}

async function suite() {
  const environment = await preflight();
  const lock = await open(join(directory, '.live-lock'), 'wx', 0o600);
  const batch = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6);
  const evidence = join(directory, 'evidence', batch);
  const temporary = await mkdtemp(join(tmpdir(), 'atelier-t01-'));
  const workspace = join(temporary, 'workspace'); const state = join(temporary, 'sdk-state'); const raw = join(temporary, 'private-logs');
  for (const path of [evidence, workspace, state, raw]) await mkdir(path, { recursive: true, mode: 0o700 });
  const marker = randomUUID();
  await writeFile(join(workspace, 'reading.txt'), `Random verification marker: ${marker}\n`, { mode: 0o600 });
  await writeFile(join(workspace, 'note.txt'), 'ORIGINAL\n');
  await writeFile(join(workspace, 'cancel.txt'), 'WAITING\n');
  await writeFile(join(temporary, 'outside-sentinel.txt'), 'OUTSIDE_UNCHANGED\n');
  const sentinel = hash(await readFile(join(temporary, 'outside-sentinel.txt')));
  const cases: Record<string, unknown>[] = [];
  let sessionId: string | undefined;
  let active: Session | undefined;
  const onSignal = () => active?.abort('operator-SIGINT');
  process.once('SIGINT', onSignal);
  await writeFile(join(evidence, 'environment.json'), JSON.stringify({ ...environment, batch, temporary, constraints: { maximumInputs: 8, maximumQueries: 8, maximumTurns: 6, timeoutMs: 120000, softPerQueryUsd: 0.5, softBatchUsd: 4 }, markerHash: hash(marker) }, null, 2) + '\n');

  async function scenario(name: string, tools: string[], inputs: number, exercise: (session: Session) => Promise<void>, extra: Partial<SessionConfig> = {}) {
    console.log(`START ${name}`);
    const emit = evidenceWriter(join(evidence, name + '.jsonl'), name, [...secretValues, marker]);
    const before = await inventory(workspace);
    let session: Session | undefined;
    let status = 'PASS'; let failure: string | null = null;
    const started = Date.now();
    try {
      reserve(name, inputs, batch);
      session = new Session({ name, workspace, state, raw, tools, emit, ...extra }); active = session;
      await exercise(session);
      assert.equal(session.timedOut, false, 'SCENARIO_TIMED_OUT');
    } catch (error) { status = 'FAIL'; failure = safeError(error); }
    finally {
      if (session) {
        try { await session.close(); } catch (error) { status = 'FAIL'; failure = safeError(error); }
        account(session.observer.results);
      }
      active = undefined;
    }
    const after = await inventory(workspace);
    if (hash(await readFile(join(temporary, 'outside-sentinel.txt'))) !== sentinel) { status = 'FAIL'; failure = 'OUTSIDE_SENTINEL_CHANGED'; }
    if (name !== 'allow-files' && JSON.stringify(before) !== JSON.stringify(after)) { status = 'FAIL'; failure = 'UNEXPECTED_FILESYSTEM_CHANGE'; }
    const record = { name, status, failure, durationMs: Date.now() - started, before, after, sentinelUnchanged: hash(await readFile(join(temporary, 'outside-sentinel.txt'))) === sentinel,
      processExit: session?.exited ?? null, cancellationReason: session?.cancellationReason ?? null, readerError: session?.readError ?? null,
      sdk: session?.observer.summary() ?? null, permissions: session?.policy.decisions ?? [], evidence: name + '.jsonl' };
    cases.push(record); emit('scenario.assertions', { status, failure, before, after, processExit: session?.exited ?? null });
    await writeFile(join(evidence, 'results.json'), JSON.stringify({ batch, environment, cases, ledger: loadLedger(), actualBillingUsd: null }, null, 2) + '\n');
    console.log(`${status} ${name}${failure ? ': ' + failure : ''}`);
    return status === 'PASS';
  }

  try {
    const readPassed = await scenario('readonly', ['Read'], 1, async session => {
      success(await session.run('Use Read to read reading.txt in the working directory. Reply with the exact verification marker in the file. Do not modify anything.'));
      assert.ok(session.observer.successfulTool('Read'), 'READ_TOOL_RESULT_REQUIRED');
      assert.ok(session.observer.finalText().includes(marker), 'MARKER_MISMATCH');
      assert.ok(session.observer.textDeltas > 0 && session.observer.messageStops > 0, 'STREAMING_EVIDENCE_REQUIRED');
      sessionId = session.observer.sessionId; assert.ok(sessionId);
    });
    if (!readPassed) return;

    await scenario('resume', [], 1, async session => {
      success(await session.run('What exact verification marker did you read earlier? Reply only with that marker. Do not read any file.'));
      assert.ok(session.observer.finalText().includes(marker), 'RESUMED_MARKER_MISMATCH');
      assert.equal(session.observer.calls.size, 0, 'RESUME_MUST_NOT_READ_FILES');
    }, { resume: sessionId });

    let deniedWhileUnchanged = false;
    await scenario('deny-edit', ['Read', 'Edit'], 1, async session => {
      success(await session.run('Read note.txt, then attempt exactly once to Edit ORIGINAL to DENIED. If denied, report the denial and stop. Never retry or use a different operation.'));
      assert.ok(deniedWhileUnchanged, 'NO_PENDING_APPROVAL');
      assert.ok(session.policy.decisions.some(item => item.decision === 'denied'), 'NO_DENIAL');
      assert.equal(session.observer.successfulTool('Edit'), false, 'DENIED_EDIT_EXECUTED');
    }, { decide: async (operation, gate) => {
      await nextTick();
      deniedWhileUnchanged = gate.state === 'pending' && hash(await readFile(join(workspace, operation.path))) === operation.beforeHash;
      gate.settle('denied');
    } });

    await scenario('allow-files', ['Read', 'Edit', 'Write'], 1, async session => {
      success(await session.run('Read note.txt. Use Edit exactly once to replace ORIGINAL with APPROVED, preserving the newline. Then use Write exactly once to create created.txt with exactly CREATED and one trailing newline. Do not change any other file.'));
      assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'APPROVED\n');
      assert.equal(await readFile(join(workspace, 'created.txt'), 'utf8'), 'CREATED\n');
      assert.ok(session.observer.successfulTool('Edit') && session.observer.successfulTool('Write'), 'BOTH_FILE_TOOL_RESULTS_REQUIRED');
      assert.equal(session.policy.decisions.filter(item => item.decision === 'allowed').length, 2, 'EXACTLY_TWO_APPROVALS_REQUIRED');
      const expected = { 'cancel.txt': hash('WAITING\n'), 'created.txt': hash('CREATED\n'), 'note.txt': hash('APPROVED\n'), 'reading.txt': hash(`Random verification marker: ${marker}\n`) };
      assert.deepEqual(await inventory(workspace), expected, 'UNEXPECTED_ALLOW_SIDE_EFFECT');
    }, { decide: async (operation, gate) => {
      await nextTick();
      const exactEdit = operation.name === 'Edit' && operation.path === 'note.txt' && operation.before === 'ORIGINAL\n' && operation.after === 'APPROVED\n';
      const exactWrite = operation.name === 'Write' && operation.path === 'created.txt' && operation.before === null && operation.after === 'CREATED\n';
      gate.settle(exactEdit || exactWrite ? 'allowed' : 'denied');
    } });

    let pendingGate: ApprovalGate | undefined;
    let pendingReached = false;
    await scenario('cancel-permission', ['Read', 'Edit'], 1, async session => {
      await session.run('Read cancel.txt, then use Edit exactly once to replace WAITING with SHOULD_NOT_APPEAR. Await the permission decision.').catch(error => { assert.equal(error.message, 'QUERY_CANCELED'); });
      assert.ok(pendingReached, 'PENDING_PERMISSION_NOT_REACHED');
      assert.equal(pendingGate!.settle('allowed'), false, 'LATE_ALLOW_ACCEPTED');
      assert.ok(session.policy.decisions.some(item => item.decision === 'canceled'), 'PERMISSION_NOT_CANCELED');
    }, { decide: async (operation, gate) => {
      await nextTick();
      assert.equal(hash(await readFile(join(workspace, operation.path))), operation.beforeHash, 'MUTATED_WHILE_PENDING');
      pendingGate = gate; pendingReached = true;
      active!.abort('pending-permission');
      assert.equal(gate.settle('allowed'), false, 'RACING_ALLOW_ACCEPTED');
    } });

    let interruptSent = false;
    let receipt: Promise<unknown> | undefined;
    await scenario('interrupt-continue', [], 2, async session => {
      const first = await session.run('Generate a numbered list of 1000 short distinct sentences about trees. Start the list immediately.');
      assert.ok(interruptSent, 'NO_STREAM_TO_INTERRUPT');
      await deadline(receipt!, 5000);
      assert.ok(['aborted_streaming', 'aborted_tools'].includes(first.terminal_reason ?? ''), 'NOT_AN_INTERRUPTED_TURN');
      assert.equal(session.exited, undefined, 'INTERRUPT_KILLED_PROCESS');
      const second = await session.run('Stop the list. Reply with exactly CONTINUED.'); success(second);
      assert.ok(session.observer.finalText().includes('CONTINUED'), 'FOLLOWUP_FAILED');
    }, { onMessage: (message, session) => {
      if (!interruptSent && message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
        interruptSent = true; session.config.emit('interrupt.requested', {});
        receipt = session.connection.interrupt().then(value => { session.config.emit('interrupt.receipt', { received: true, value }); return value; });
        void receipt.catch(() => {});
      }
    } });

    let abortSent = false;
    await scenario('abort-generation', [], 1, async session => {
      await session.run('Generate a numbered list of 1000 short distinct sentences about rivers. Start immediately.').catch(error => { assert.equal(error.message, 'QUERY_CANCELED'); });
      assert.ok(abortSent, 'NO_ACTIVE_GENERATION_TO_ABORT');
      assert.equal(session.cancellationReason, 'active-generation');
    }, { onMessage: (message, session) => {
      if (!abortSent && message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
        abortSent = true; session.abort('active-generation');
      }
    } });
  } finally {
    process.removeListener('SIGINT', onSignal);
    await lock.close(); await rm(join(directory, '.live-lock'));
    const text = JSON.stringify({ batch, environment, cases, ledger: loadLedger(), actualBillingUsd: null }, null, 2) + '\n';
    for (const secret of secretValues.filter(value => value.length > 8)) assert.equal(text.includes(secret), false, 'SECRET_IN_SUMMARY');
    await writeFile(join(evidence, 'results.json'), text);
    console.log(`EVIDENCE ${evidence}`);
    console.log(`TEMPORARY ${temporary}`);
    console.log(`RESULT ${cases.length === 7 && cases.every(item => item.status === 'PASS') ? 'PASS' : 'INCOMPLETE'}`);
    if (cases.length !== 7 || cases.some(item => item.status !== 'PASS')) process.exitCode = 1;
  }
}

try {
  if (process.argv.includes('--preflight')) console.log(JSON.stringify(await preflight(), null, 2));
  else if (process.argv.includes('--suite') && process.argv[process.argv.indexOf('--suite') + 1] === 'core') await suite();
  else throw new Error('Use --preflight for no-inference checks or --suite core for the authorized live batch.');
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
