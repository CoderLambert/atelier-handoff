/**
 * @file 验证原生 Agent SDK 进程生命周期接口的 Linux 退出、取消和跨运行隔离。
 * @implementation 在临时目录启动真实 Node 父子孙进程，检查 EOF 宽限、退出后孤儿清理、脱组追踪和无关进程存活。
 * @updated 2026-11-22T12:00:00+08:00
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { query, type Options, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { createHarnessProcess, type HarnessProcess } from '../server/harness-process.js';

const linuxOnly = { skip: process.platform !== 'linux', timeout: 12_000 };
const shortTimeouts = {
  gracefulTimeoutMs: 200,
  terminateTimeoutMs: 100,
  killTimeoutMs: 1_000,
  observeIntervalMs: 10,
};

type Notice = { event: string; label: string; pid: number };

function notices(child: ChildProcessWithoutNullStreams) {
  let pending = '';
  const received: Notice[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const value: unknown = JSON.parse(line);
      assert.ok(value && typeof value === 'object');
      assert.ok('event' in value && typeof value.event === 'string');
      assert.ok('label' in value && typeof value.label === 'string');
      assert.ok('pid' in value && typeof value.pid === 'number' && value.pid > 1);
      received.push({ event: value.event, label: value.label, pid: value.pid });
    }
  });
  return {
    received,
    async wait(label: string, event = 'ready'): Promise<Notice> {
      await eventually(() =>
        received.some((notice) => notice.label === label && notice.event === event),
      );
      const notice = received.find((notice) => notice.label === label && notice.event === event);
      assert.ok(notice);
      return notice;
    },
  };
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeout = 4_000,
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!(await predicate())) {
    if (performance.now() >= deadline)
      assert.fail('Process fixture did not reach its expected state.');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function isRunning(pid: number): Promise<boolean> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const state = text.slice(text.lastIndexOf(') ') + 2).split(' ')[0];
    return state !== 'Z' && state !== 'X' && state !== 'x';
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ESRCH')
    )
      return false;
    throw error;
  }
}

function say(label: string, event: string): string {
  return `console.log(JSON.stringify({label:${JSON.stringify(label)},event:${JSON.stringify(event)},pid:process.pid}));`;
}

function idleSource(label: string): string {
  return `
    process.title = 'harness fixture ) ( ${label}';
    process.on('SIGTERM', () => { ${say(label, 'term')} });
    process.on('SIGUSR1', () => process.exit(0));
    ${say(label, 'ready')}
    setInterval(() => {}, 1000);
  `;
}

function treeSource(detachedShell = false): string {
  const shell = `
    const {spawn} = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(idleSource('grandchild'))}], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    grandchild.unref();
    ${idleSource('shell')}
  `;
  return `
    const {spawn} = require('node:child_process');
    const shell = spawn(process.execPath, ['-e', ${JSON.stringify(shell)}], {
      detached: ${JSON.stringify(detachedShell)},
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    shell.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => {
      if (data.includes('exit-shell')) shell.kill('SIGUSR1');
      if (data.includes('exit-root')) process.exit(0);
    });
    process.stdin.resume();
    ${idleSource('root')}
  `;
}

async function fixture(t: TestContext, handle: HarnessProcess, source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-harness-process-'));
  const forwardedAbort = new AbortController();
  const spawnOptions: SpawnOptions = {
    command: process.execPath,
    args: ['--input-type=commonjs', '-e', source],
    cwd: directory,
    env: {},
    signal: forwardedAbort.signal,
  };
  // Compile-time compatibility with the actual locked SDK, including its non-null streams.
  const hook: NonNullable<Options['spawnClaudeCodeProcess']> = handle.spawnClaudeCodeProcess;
  assert.equal(typeof hook, 'function');
  const child = handle.spawnClaudeCodeProcess(spawnOptions);
  const output = notices(child);
  t.after(async () => {
    await handle.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return { child, output, forwardedAbort, spawnOptions };
}

async function assertGone(pids: number[]): Promise<void> {
  for (const pid of pids) await eventually(async () => !(await isRunning(pid)));
}

test('normal Node completion preserves code and stderr without force', linuxOnly, async (t) => {
  const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
  const handle = createHarnessProcess({ ...shortTimeouts, onExit: (exit) => exits.push(exit) });
  const { child, output } = await fixture(
    t,
    handle,
    `process.stderr.write('fixture error tail'); ${say('root', 'ready')}
     process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`,
  );
  await output.wait('root');
  child.stdin.end();
  const report = await handle.cleanup();
  assert.equal(report.containment, 'linux-session');
  assert.equal(report.rootExited, true);
  assert.deepEqual(report.exit, { code: 0, signal: null });
  assert.equal(report.escalated, false);
  assert.equal(report.stderrBytes, Buffer.byteLength('fixture error tail'));
  assert.deepEqual(report.remainingPids, []);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(exits, [{ code: 0, signal: null }]);
});

test(
  'stop preserves SDK-style stdin EOF grace and is an idempotent barrier',
  linuxOnly,
  async (t) => {
    const controller = new AbortController();
    const handle = createHarnessProcess({
      ...shortTimeouts,
      gracefulTimeoutMs: 1_000,
      abortController: controller,
    });
    const { output, forwardedAbort } = await fixture(
      t,
      handle,
      `${idleSource('root')}
     process.stdin.resume();
     process.stdin.on('end', () => {
       ${say('root', 'eof')}
       setTimeout(() => process.exit(0), 120);
     });`,
    );
    await output.wait('root');
    const stopped = handle.stop();
    assert.equal(controller.signal.aborted, true);
    assert.equal(forwardedAbort.signal.aborted, false);
    assert.equal(handle.stop(), stopped);
    assert.equal(handle.cleanup(), stopped);
    const report = await stopped;
    await output.wait('root', 'eof');
    assert.deepEqual(report.exit, { code: 0, signal: null });
    assert.equal(report.escalated, false);
    assert.equal(
      output.received.some((notice) => notice.event === 'term'),
      false,
    );
    assert.deepEqual(report.remainingPids, []);
  },
);

test(
  'cancellation terminates real Node parent, child and grandchild ignoring TERM',
  linuxOnly,
  async (t) => {
    const handle = createHarnessProcess(shortTimeouts);
    const { output } = await fixture(t, handle, treeSource());
    const root = await output.wait('root');
    const shell = await output.wait('shell');
    const grandchild = await output.wait('grandchild');
    handle.abortController.abort();
    const report = await handle.cleanup();
    assert.equal(report.rootExited, true);
    assert.equal(report.escalated, true);
    assert.deepEqual(report.exit, { code: null, signal: 'SIGKILL' });
    assert.deepEqual(report.remainingPids, []);
    assert.deepEqual(report.issues, []);
    await assertGone([root.pid, shell.pid, grandchild.pid]);
  },
);

test(
  'automatic cleanup retains the lingering process group after SDK root exit',
  linuxOnly,
  async (t) => {
    let didExit = false;
    const handle = createHarnessProcess({
      ...shortTimeouts,
      onExit: () => {
        didExit = true;
      },
    });
    const { child, output } = await fixture(t, handle, treeSource());
    const root = await output.wait('root');
    const shell = await output.wait('shell');
    const grandchild = await output.wait('grandchild');
    child.stdin.write('exit-root\n');
    await eventually(() => didExit);
    // No cleanup() call until the exit-triggered cleanup has actually stopped the orphan.
    await assertGone([shell.pid, grandchild.pid]);
    const report = await handle.cleanup();
    assert.deepEqual(report.exit, { code: 0, signal: null });
    assert.equal(report.escalated, true);
    assert.deepEqual(report.remainingPids, []);
    await assertGone([root.pid]);
  },
);

test('grandchild remains owned after its intermediate parent exits first', linuxOnly, async (t) => {
  const handle = createHarnessProcess(shortTimeouts);
  const { child, output } = await fixture(t, handle, treeSource());
  await output.wait('root');
  const shell = await output.wait('shell');
  const grandchild = await output.wait('grandchild');
  child.stdin.write('exit-shell\n');
  await assertGone([shell.pid]);
  assert.equal(await isRunning(grandchild.pid), true);
  const report = await handle.stop();
  assert.equal(report.rootExited, true);
  assert.deepEqual(report.remainingPids, []);
  await assertGone([grandchild.pid]);
});

test(
  'observed detached shell session and reparented grandchild are also cleaned',
  linuxOnly,
  async (t) => {
    const handle = createHarnessProcess(shortTimeouts);
    const { child, output } = await fixture(t, handle, treeSource(true));
    await output.wait('root');
    const shell = await output.wait('shell');
    const grandchild = await output.wait('grandchild');
    // Keep the ancestry observable for several real sampling turns before reparenting.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    child.stdin.write('exit-shell\n');
    await assertGone([shell.pid]);
    assert.equal(await isRunning(grandchild.pid), true);
    child.stdin.write('exit-root\n');
    await assertGone([grandchild.pid]);
    const report = await handle.cleanup();
    assert.deepEqual(report.remainingPids, []);
    assert.deepEqual(report.exit, { code: 0, signal: null });
  },
);

test(
  'concurrent runs and an unrelated sibling survive another run cancellation',
  linuxOnly,
  async (t) => {
    const first = createHarnessProcess(shortTimeouts);
    const second = createHarnessProcess(shortTimeouts);
    const a = await fixture(t, first, treeSource());
    const b = await fixture(t, second, treeSource());
    const bystander = spawn(process.execPath, ['-e', idleSource('bystander')], {
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const unrelated = notices(bystander);
    t.after(async () => {
      const done = new Promise<void>((resolve) => bystander.once('exit', () => resolve()));
      bystander.kill('SIGKILL');
      await done;
    });
    const aRoot = await a.output.wait('root');
    const aShell = await a.output.wait('shell');
    const aGrandchild = await a.output.wait('grandchild');
    const bRoot = await b.output.wait('root');
    const bShell = await b.output.wait('shell');
    const bGrandchild = await b.output.wait('grandchild');
    const other = await unrelated.wait('bystander');
    const report = await first.stop();
    assert.deepEqual(report.remainingPids, []);
    await assertGone([aRoot.pid, aShell.pid, aGrandchild.pid]);
    for (const notice of [bRoot, bShell, bGrandchild, other])
      assert.equal(await isRunning(notice.pid), true, `${notice.label} belongs to another owner`);
    assert.equal(
      b.output.received.some((notice) => notice.event === 'term'),
      false,
    );
    assert.equal(
      unrelated.received.some((notice) => notice.event === 'term'),
      false,
    );
    await second.stop();
    assert.equal(await isRunning(other.pid), true);
  },
);

test('forwarded SDK AbortError is not mistaken for actual process exit', linuxOnly, async (t) => {
  const handle = createHarnessProcess(shortTimeouts);
  const { output, forwardedAbort } = await fixture(t, handle, idleSource('root'));
  const root = await output.wait('root');
  forwardedAbort.abort();
  await output.wait('root', 'term');
  assert.equal(await isRunning(root.pid), true);
  const report = await handle.stop();
  assert.equal(report.rootExited, true);
  assert.equal(report.escalated, true);
  assert.deepEqual(report.issues, []);
  await assertGone([root.pid]);
});

test(
  'spawn failure settles cleanup, and a finished owner cannot spawn a new run',
  linuxOnly,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'atelier-harness-missing-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const handle = createHarnessProcess(shortTimeouts);
    const spawnOptions: SpawnOptions = {
      command: join(directory, 'not-an-executable'),
      args: [],
      cwd: directory,
      env: {},
      signal: new AbortController().signal,
    };
    handle.spawnClaudeCodeProcess(spawnOptions);
    const report = await handle.cleanup();
    assert.equal(report.rootExited, true);
    assert.deepEqual(report.remainingPids, []);
    assert.ok(
      report.issues.some((issue) => issue.operation === 'spawn' && issue.code === 'ENOENT'),
    );
    assert.throws(() => handle.spawnClaudeCodeProcess(spawnOptions), /exactly one SDK spawn/);
  },
);

test(
  'locked SDK ProcessTransport accepts the hook and preserves graceful abort',
  linuxOnly,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'atelier-harness-sdk-transport-'));
    const executable = join(directory, 'cli-fixture.js');
    // The real locked SDK transport speaks to a local protocol fixture. No native CLI,
    // model request, credential lookup, HTTP listener or user configuration is involved.
    await writeFile(
      executable,
      `
    const {createInterface} = require('node:readline');
    const lines = createInterface({input:process.stdin});
    process.on('SIGTERM', () => process.stderr.write('term\\n'));
    const idle = setInterval(() => {}, 1000);
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.type === 'control_request') {
        process.stdout.write(JSON.stringify({
          type:'control_response',
          response:{subtype:'success',request_id:message.request_id,response:{commands:[],agents:[],models:[]}},
        })+'\\n');
      }
    });
    lines.on('close', () => {
      process.stderr.write('eof\\n');
      setTimeout(() => { clearInterval(idle); process.exit(0); }, 120);
    });
  `,
    );
    let forwarded: AbortSignal | undefined;
    let stderr = '';
    const handle = createHarnessProcess({
      ...shortTimeouts,
      gracefulTimeoutMs: 3_000,
      onSpawn(child) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
      },
    });
    const connection = query({
      prompt: 'local transport fixture',
      options: {
        executable: 'node',
        pathToClaudeCodeExecutable: executable,
        cwd: directory,
        settingSources: [],
        persistSession: false,
        abortController: handle.abortController,
        spawnClaudeCodeProcess(spawnOptions) {
          forwarded = spawnOptions.signal;
          assert.equal(spawnOptions.command, 'node');
          assert.ok(spawnOptions.args.includes(executable));
          return handle.spawnClaudeCodeProcess({
            ...spawnOptions,
            command: process.execPath,
            env: {},
          });
        },
      },
    });
    t.after(async () => {
      connection.close();
      await handle.stop();
      await rm(directory, { recursive: true, force: true });
    });
    assert.deepEqual(await connection.supportedCommands(), []);
    assert.ok(forwarded);
    assert.notEqual(forwarded, handle.abortController.signal);
    handle.abortController.abort();
    assert.equal(forwarded.aborted, false, 'the raw abort must not synchronously kill the child');
    const report = await handle.cleanup();
    assert.deepEqual(report.exit, { code: 0, signal: null });
    assert.equal(report.escalated, false);
    assert.equal(stderr, 'eof\n');
    assert.deepEqual(report.remainingPids, []);
    assert.deepEqual(report.issues, []);
  },
);

test('an already cancelled owner never launches the requested executable', linuxOnly, async () => {
  const abortController = new AbortController();
  abortController.abort();
  const handle = createHarnessProcess({ ...shortTimeouts, abortController });
  assert.throws(
    () =>
      handle.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ['-e', 'process.exit(99)'],
        env: {},
        signal: new AbortController().signal,
      }),
    { name: 'AbortError' },
  );
  assert.equal(handle.child, undefined);
  const report = await handle.cleanup();
  assert.equal(report.rootExited, true);
  assert.equal(report.exit, null);
  assert.deepEqual(report.remainingPids, []);
});
