/**
 * @file 验证人工终端的幂等、连接代次和清理屏障。
 * @implementation 用真实会话与 headless 屏幕测试 manager，仅替代进程边界以注入关闭竞态。
 * @updated 2026-11-26T01:00:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { TerminalManager } from '../server/modules/terminal/manager.js';
import { terminalLimits } from '../shared/terminal.js';
import { terminalFixture } from './fixtures/terminal-fixture.js';
import { processDoubleProvider, TerminalSink, until } from './fixtures/terminal-process-double.js';

async function fixture() {
  const f = await terminalFixture();
  const fake = processDoubleProvider();
  let deleting = false;
  const manager = new TerminalManager({
    store: f.store,
    worktrees: f.worktrees,
    supported: true,
    isSessionDeleting: () => deleting,
    processProvider: fake.provider,
  });
  const request = () => ({
    runtimeId: manager.capabilities().runtimeId,
    terminalId: randomUUID(),
    expectedWorkspaceId: null,
    cols: 80,
    rows: 24,
  });
  const attach = async (terminalId: string) => {
    const sink = new TerminalSink();
    const attachment = manager.attach(f.session.id, terminalId, sink);
    const snapshot = await sink.frame('snapshot');
    return {
      sink,
      attachment,
      snapshot,
      ready: () =>
        attachment.receive({
          type: 'ready',
          attachmentId: attachment.attachmentId,
          seq: snapshot.seq,
        }),
    };
  };
  return {
    ...f,
    ...fake,
    manager,
    request,
    attach,
    setDeleting: () => {
      deleting = true;
    },
    async dispose() {
      await manager.shutdown();
      await f.dispose();
    },
  };
}

test('create is idempotent and reserves a live session without spawning before first ready', async () => {
  const f = await fixture();
  try {
    const request = f.request();
    const [a, b] = await Promise.all([
      f.manager.create(f.session.id, request),
      f.manager.create(f.session.id, request),
    ]);
    assert.equal(a.terminal.terminalId, b.terminal.terminalId);
    assert.equal(a.terminal.state, 'awaiting-attach');
    assert.equal(f.processes.length, 0);
    assert.throws(() => f.manager.assertSessionIdle(f.session.id), { code: 'TERMINAL_ACTIVE' });
    await assert.rejects(f.manager.create(f.session.id, { ...request, cols: 81 }), {
      code: 'TERMINAL_ID_CONFLICT',
    });
    const connected = await f.attach(request.terminalId);
    await connected.ready();
    await connected.ready();
    assert.equal(f.processes.length, 1);
    assert.equal((await connected.sink.frame('readyAccepted')).writable, true);
    assert.equal(f.processes[0]?.options.cwd, f.project.path);
    assert.equal((await f.manager.create(f.session.id, request)).terminal.state, 'running');
  } finally {
    await f.dispose();
  }
});

test('close tombstone prevents a delayed create and session deletion revokes first-ready spawn', async () => {
  const f = await fixture();
  try {
    const old = f.request();
    await f.manager.close(f.session.id, old.runtimeId, old.terminalId);
    await assert.rejects(f.manager.create(f.session.id, old), { code: 'TERMINAL_CLOSED' });
    const next = f.request();
    await f.manager.create(f.session.id, next);
    const connected = await f.attach(next.terminalId);
    f.setDeleting();
    await assert.rejects(connected.ready(), { code: 'SESSION_DELETING' });
    assert.equal(f.processes.length, 0);
    await assert.rejects(
      f.manager.create(f.session.id, { ...f.request(), runtimeId: randomUUID() }),
      { code: 'TERMINAL_RUNTIME_CHANGED' },
    );
  } finally {
    await f.dispose();
  }
});

test('replacement rejects stale input, binary input preserves bytes, and reattach restores screen', async () => {
  const f = await fixture();
  try {
    const request = f.request();
    await f.manager.create(f.session.id, request);
    const first = await f.attach(request.terminalId);
    await first.ready();
    const process = f.processes[0];
    assert.ok(process);
    process.output('\u001b[31m你好\u001b[0m\r\n');
    await first.sink.frame('output');
    const second = await f.attach(request.terminalId);
    assert.equal(first.sink.closed, 'TERMINAL_REPLACED');
    assert.ok(second.snapshot.screen.includes('你好'));
    await assert.rejects(
      first.attachment.receive({
        type: 'input',
        attachmentId: first.attachment.attachmentId,
        inputSeq: 1,
        payload: { encoding: 'utf8', data: 'wrong' },
      }),
      { code: 'TERMINAL_REPLACED' },
    );
    await assert.rejects(
      second.attachment.receive({
        type: 'input',
        attachmentId: second.attachment.attachmentId,
        inputSeq: 1,
        payload: { encoding: 'utf8', data: 'early' },
      }),
      { code: 'TERMINAL_NOT_READY' },
    );
    await second.ready();
    await second.attachment.receive({
      type: 'input',
      attachmentId: second.attachment.attachmentId,
      inputSeq: 1,
      payload: { encoding: 'binary', base64: '/wAB' },
    });
    assert.deepEqual(process.writes, [Buffer.from([255, 0, 1])]);
    await second.attachment.receive({
      type: 'resize',
      attachmentId: second.attachment.attachmentId,
      commandSeq: 1,
      cols: 100,
      rows: 40,
    });
    assert.deepEqual(process.sizes, [[100, 40]]);
    second.attachment.detach();
    assert.equal(process.paused, false);
    assert.equal(f.manager.list(f.session.id).terminals[0]?.state, 'running');
  } finally {
    await f.dispose();
  }
});

test('natural exit drains final output, releases the session guard and keeps the retained screen', async () => {
  const f = await fixture();
  try {
    const request = f.request();
    await f.manager.create(f.session.id, request);
    const attached = await f.attach(request.terminalId);
    await attached.ready();
    const process = f.processes[0];
    assert.ok(process);
    process.output('last line 世界\r\n');
    process.exit(4);
    await until(() => f.manager.list(f.session.id).terminals[0]?.state === 'exited');
    f.manager.assertSessionIdle(f.session.id);
    const again = await f.attach(request.terminalId);
    assert.ok(again.snapshot.screen.includes('last line 世界'));
    await again.ready();
    assert.equal((await again.sink.frame('readyAccepted')).writable, false);
    await f.manager.disposeSession(f.session.id);
    assert.deepEqual(f.manager.list(f.session.id).terminals, []);
  } finally {
    await f.dispose();
  }
});

test('a slow subscriber is disconnected without pausing the PTY indefinitely', async () => {
  const f = await fixture();
  try {
    const request = f.request();
    await f.manager.create(f.session.id, request);
    const attached = await f.attach(request.terminalId);
    await attached.ready();
    const process = f.processes[0];
    assert.ok(process);
    attached.sink.bufferedAmount = 2 * 1024 * 1024;
    process.output('progress\r\n');
    await until(() => attached.sink.closed !== undefined);
    assert.equal(attached.sink.closed, 'TERMINAL_SLOW_CONSUMER');
    assert.equal(process.paused, false);
    assert.equal(f.manager.list(f.session.id).terminals[0]?.state, 'running');
  } finally {
    await f.dispose();
  }
});

test(
  'cleanup timeout retains ownership until a late exit completes cleanup',
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const request = f.request();
      await f.manager.create(f.session.id, request);
      const attached = await f.attach(request.terminalId);
      await attached.ready();
      const process = f.processes[0];
      assert.ok(process);
      process.ignoreSignals = true;
      const result = await f.manager.close(f.session.id, request.runtimeId, request.terminalId);
      assert.equal(result.state, 'cleanup-failed');
      assert.deepEqual(process.signals, ['SIGHUP', 'SIGTERM', 'SIGKILL']);
      assert.throws(() => f.manager.assertSessionIdle(f.session.id), { code: 'TERMINAL_ACTIVE' });
      process.exit();
      await until(() => f.manager.list(f.session.id).terminals.length === 0);
      f.manager.assertSessionIdle(f.session.id);
    } finally {
      await f.dispose();
    }
  },
);

test('shutdown still terminates every PTY when a disconnected read stream rejects resume', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 2; index++) {
      const request = f.request();
      await f.manager.create(f.session.id, request);
      await (await f.attach(request.terminalId)).ready();
    }
    const broken = f.processes[0];
    assert.ok(broken);
    broken.failResume = true;
    assert.deepEqual(await f.manager.shutdown(), { closed: 2, failed: [] });
    assert.equal(f.processes[0]?.disposed, true);
    assert.equal(f.processes[1]?.disposed, true);
  } finally {
    await f.dispose();
  }
});

test('the first-ready deadline releases an unused reservation without ever starting a shell', async (context) => {
  const f = await fixture();
  try {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const request = f.request();
    await f.manager.create(f.session.id, request);
    context.mock.timers.tick(terminalLimits.firstReadyMs);
    await nextTurn();
    assert.deepEqual(f.manager.list(f.session.id).terminals, []);
    f.manager.assertSessionIdle(f.session.id);
    assert.equal(f.processes.length, 0);
    await assert.rejects(f.manager.create(f.session.id, request), { code: 'TERMINAL_CLOSED' });
  } finally {
    context.mock.timers.reset();
    await f.dispose();
  }
});

test('replaced snapshot cleanup cannot release the new attachment pause and timeout resumes the PTY', async (context) => {
  const f = await fixture();
  try {
    const request = f.request();
    await f.manager.create(f.session.id, request);
    const first = await f.attach(request.terminalId);
    await first.ready();
    const process = f.processes[0];
    assert.ok(process);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const secondSink = new TerminalSink();
    const second = f.manager.attach(f.session.id, request.terminalId, secondSink);
    await nextTurn();
    context.mock.timers.tick(9000);
    const thirdSink = new TerminalSink();
    const third = f.manager.attach(f.session.id, request.terminalId, thirdSink);
    await nextTurn();
    second.detach();
    context.mock.timers.tick(1001);
    assert.equal(secondSink.closed, 'TERMINAL_REPLACED');
    assert.equal(thirdSink.closed, undefined);
    assert.equal(process.paused, true);
    context.mock.timers.tick(8999);
    assert.equal(thirdSink.closed, 'TERMINAL_READY_TIMEOUT');
    assert.equal(process.paused, false);
    third.detach();
    assert.equal(f.manager.list(f.session.id).terminals[0]?.state, 'running');
  } finally {
    context.mock.timers.reset();
    await f.dispose();
  }
});

test('tickets expire, are revoked by replacement tickets and close, and never cross session ownership', async (context) => {
  const f = await fixture();
  try {
    context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const request = f.request();
    await f.manager.create(f.session.id, request);
    const issue = () =>
      f.manager.ticket(
        f.session.id,
        request.runtimeId,
        request.terminalId,
        'http://127.0.0.1:1234',
      );
    const first = issue();
    const second = issue();
    assert.throws(() => f.manager.consumeTicket(first.ticket, 'http://127.0.0.1:1234'), {
      code: 'TERMINAL_TICKET_INVALID',
    });
    context.mock.timers.setTime(Date.now() + terminalLimits.ticketTtlMs);
    assert.throws(() => f.manager.consumeTicket(second.ticket, 'http://127.0.0.1:1234'), {
      code: 'TERMINAL_TICKET_INVALID',
    });
    const otherId = randomUUID();
    f.store.put('sessions', { ...f.session, id: otherId });
    assert.throws(
      () =>
        f.manager.ticket(otherId, request.runtimeId, request.terminalId, 'http://127.0.0.1:1234'),
      { code: 'TERMINAL_NOT_FOUND' },
    );
    const final = issue();
    await f.manager.close(f.session.id, request.runtimeId, request.terminalId);
    assert.throws(() => f.manager.consumeTicket(final.ticket, 'http://127.0.0.1:1234'), {
      code: 'TERMINAL_TICKET_INVALID',
    });
  } finally {
    context.mock.timers.reset();
    await f.dispose();
  }
});

test('final directory and archived-session checks reject first-ready without a process', async () => {
  const f = await fixture();
  try {
    const request = f.request();
    await f.manager.create(f.session.id, request);
    const first = await f.attach(request.terminalId);
    f.store.update('projects', f.project.id, { path: f.base });
    await assert.rejects(first.ready(), { code: 'GIT_WORKTREE_CHANGED' });
    f.store.update('projects', f.project.id, { path: f.project.path });
    await f.manager.close(f.session.id, request.runtimeId, request.terminalId);
    const next = f.request();
    await f.manager.create(f.session.id, next);
    const attached = await f.attach(next.terminalId);
    f.store.update('sessions', f.session.id, { status: 'archived' });
    await assert.rejects(attached.ready(), { code: 'SESSION_ARCHIVED' });
    assert.equal(f.processes.length, 0);
  } finally {
    await f.dispose();
  }
});

test(
  'a large screen uses the separate snapshot budget while ordinary unacknowledged output disconnects',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const request = { ...f.request(), cols: 400, rows: 200 };
      await f.manager.create(f.session.id, request);
      const first = await f.attach(request.terminalId);
      await first.ready();
      const process = f.processes[0];
      assert.ok(process);
      process.output(('界'.repeat(200) + '\r\n').repeat(2001));
      assert.equal(process.paused, true);
      await until(() => first.sink.closed === 'TERMINAL_SLOW_CONSUMER', 10000);
      const second = await f.attach(request.terminalId);
      assert.ok(
        Buffer.byteLength(JSON.stringify(second.snapshot)) > terminalLimits.liveBufferBytes,
      );
      assert.equal(second.sink.closed, undefined);
      assert.equal(process.paused, true);
      await second.ready();
      assert.equal(process.paused, false);
      process.output('tail');
      const output = await second.sink.frame('output');
      assert.equal(output.seq, second.snapshot.seq + 1);
      await second.attachment.receive({
        type: 'outputAck',
        attachmentId: second.attachment.attachmentId,
        seq: output.seq,
      });
      await assert.rejects(
        second.attachment.receive({
          type: 'outputAck',
          attachmentId: second.attachment.attachmentId,
          seq: output.seq + 1,
        }),
        { code: 'TERMINAL_PROTOCOL_ERROR' },
      );
      await assert.rejects(
        second.attachment.receive({
          type: 'outputAck',
          attachmentId: second.attachment.attachmentId,
          seq: second.snapshot.seq,
        }),
        { code: 'TERMINAL_PROTOCOL_ERROR' },
      );
    } finally {
      await f.dispose();
    }
  },
);

test('the hard screen budget closes a terminal explicitly instead of silently dropping output', async () => {
  const f = await fixture();
  try {
    const request = f.request();
    await f.manager.create(f.session.id, request);
    const attached = await f.attach(request.terminalId);
    await attached.ready();
    const process = f.processes[0];
    assert.ok(process);
    process.output('x'.repeat(terminalLimits.screenHardBytes + 1));
    assert.equal(attached.sink.closed, 'TERMINAL_OUTPUT_LIMIT');
    await until(() => f.manager.list(f.session.id).terminals.length === 0);
    assert.equal(process.disposed, true);
    f.manager.assertSessionIdle(f.session.id);
  } finally {
    await f.dispose();
  }
});

test('close wins while process preparation is pending and prevents a late spawn', async () => {
  const f = await terminalFixture();
  const fake = processDoubleProvider();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = new TerminalManager({
    store: f.store,
    worktrees: f.worktrees,
    supported: true,
    isSessionDeleting: () => false,
    processProvider: {
      shellName: fake.provider.shellName,
      async prepare() {
        await gate;
        return fake.provider.prepare();
      },
    },
  });
  try {
    const request = {
      runtimeId: manager.capabilities().runtimeId,
      terminalId: randomUUID(),
      expectedWorkspaceId: null,
      cols: 80,
      rows: 24,
    };
    const creation = manager.create(f.session.id, request);
    const rejected = assert.rejects(creation);
    assert.throws(() => manager.assertSessionIdle(f.session.id), { code: 'TERMINAL_ACTIVE' });
    assert.equal(
      (await manager.close(f.session.id, request.runtimeId, request.terminalId)).state,
      'closed',
    );
    release();
    await rejected;
    assert.equal(fake.processes.length, 0);
    assert.deepEqual(manager.list(f.session.id).terminals, []);
  } finally {
    release();
    await manager.shutdown();
    await f.dispose();
  }
});

test('retained screens count toward admission and a full tombstone ledger never revives an old ID', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < terminalLimits.perSession; index++)
      await f.manager.create(f.session.id, f.request());
    await assert.rejects(f.manager.create(f.session.id, f.request()), { code: 'TERMINAL_LIMIT' });
    for (const entry of f.manager.list(f.session.id).terminals)
      await f.manager.close(f.session.id, entry.runtimeId, entry.terminalId);
    const original = f.request();
    await f.manager.close(f.session.id, original.runtimeId, original.terminalId);
    for (let index = terminalLimits.perSession + 1; index < terminalLimits.ledger; index++) {
      const request = f.request();
      await f.manager.close(f.session.id, request.runtimeId, request.terminalId);
    }
    await assert.rejects(f.manager.create(f.session.id, f.request()), { code: 'TERMINAL_LIMIT' });
    await assert.rejects(f.manager.create(f.session.id, original), { code: 'TERMINAL_CLOSED' });
  } finally {
    await f.dispose();
  }
});
