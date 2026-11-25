/**
 * @file 验证人工终端的应用入口与真实 shell 恢复。
 * @implementation 在隔离项目和数据根中通过配对 HTTP 与 WebSocket 覆盖权限、幂等创建、会话保护及同一 PTY 重连。
 * @updated 2026-11-26T04:09:19+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { createApp } from '../server/app.js';
import { desktopPairingHeader } from '../shared/desktop-host.js';
import {
  terminalCapabilitiesSchema,
  terminalCloseResponseSchema,
  terminalCreateResponseSchema,
  terminalListResponseSchema,
  terminalServerFrameSchema,
  terminalTicketResponseSchema,
  type TerminalServerFrame,
} from '../shared/terminal.js';

const errorSchema = z.object({ error: z.object({ code: z.string() }) });
const projectResponse = z.object({ project: z.object({ id: z.uuid() }) });
const sessionResponse = z.object({ session: z.object({ id: z.uuid() }) });

class TerminalPeer {
  readonly frames: TerminalServerFrame[] = [];
  private readonly events = new EventEmitter();
  constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      const frame = terminalServerFrameSchema.parse(value);
      this.frames.push(frame);
      if (frame.type === 'output')
        socket.send(
          JSON.stringify({ type: 'outputAck', attachmentId: frame.attachmentId, seq: frame.seq }),
        );
      this.events.emit('frame', frame);
    });
  }
  async wait(predicate: (frame: TerminalServerFrame) => boolean): Promise<TerminalServerFrame> {
    const current = this.frames.find(predicate);
    if (current) return current;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.events.off('frame', observe);
        reject(new Error('terminal frame timeout'));
      }, 8000);
      const observe = (frame: TerminalServerFrame) => {
        if (!predicate(frame)) return;
        clearTimeout(timer);
        this.events.off('frame', observe);
        resolve(frame);
      };
      this.events.on('frame', observe);
    });
  }
}

async function fixture(nativeExecution = true, pairing = 'terminal-api-fixture') {
  const base = await mkdtemp(join(tmpdir(), 'atelier-terminal-api-'));
  const project = join(base, 'project');
  await mkdir(project);
  const app = await createApp({
    root: process.cwd(),
    data: join(base, 'data'),
    nativeExecution,
    desktopPairing: pairing || undefined,
    runnerFactory: () => ({ start() {}, stop() {}, async shutdown() {} }),
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: origin };
  if (pairing) headers[desktopPairingHeader] = pairing;
  const bootstrap: unknown = await fetch(origin + '/api/bootstrap', { headers }).then((res) =>
    res.json(),
  );
  headers['X-Atelier-Token'] = z.object({ csrfToken: z.string() }).parse(bootstrap).csrfToken;
  const request = async (
    path: string,
    method = 'GET',
    body?: unknown,
    override?: Record<string, string>,
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers: { ...headers, ...override },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = await response.json();
    return { status: response.status, value };
  };
  const bound = await request('/api/projects', 'POST', { path: project });
  assert.equal(bound.status, 201);
  const projectId = projectResponse.parse(bound.value).project.id;
  const session = await request('/api/sessions', 'POST', { projectId });
  assert.equal(session.status, 201);
  const sessionId = sessionResponse.parse(session.value).session.id;
  return {
    app,
    origin,
    headers,
    request,
    sessionId,
    projectId,
    async dispose() {
      await app.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('terminal capability follows paired Linux x64 native execution without starting a shell', async () => {
  for (const [nativeExecution, pairing] of [
    [true, 'paired'],
    [false, 'paired'],
    [true, ''],
  ] as const) {
    const context = await fixture(nativeExecution, pairing);
    try {
      const result = await context.request('/api/terminals/capabilities');
      assert.equal(result.status, 200);
      const capabilities = terminalCapabilitiesSchema.parse(result.value);
      assert.equal(
        capabilities.supported,
        nativeExecution &&
          Boolean(pairing) &&
          process.platform === 'linux' &&
          process.arch === 'x64',
      );
      assert.equal(capabilities.protocolVersion, 1);
      const list = await context.request(`/api/sessions/${context.sessionId}/terminals`);
      assert.equal(list.status, 200);
      assert.deepEqual(terminalListResponseSchema.parse(list.value).terminals, []);
    } finally {
      await context.dispose();
    }
  }
});

test('terminal create is idempotent, refuses client executable fields and blocks archive until closed', async () => {
  const context = await fixture();
  try {
    const { runtimeId } = terminalCapabilitiesSchema.parse(
      (await context.request('/api/terminals/capabilities')).value,
    );
    const path = `/api/sessions/${context.sessionId}/terminals`;
    const request = {
      runtimeId,
      terminalId: randomUUID(),
      expectedWorkspaceId: null,
      cols: 80,
      rows: 24,
    };
    assert.equal(
      (await context.request(path, 'POST', { ...request, command: '/bin/sh' })).status,
      400,
    );
    const [first, retry] = await Promise.all([
      context.request(path, 'POST', request),
      context.request(path, 'POST', request),
    ]);
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    const terminal = terminalCreateResponseSchema.parse(first.value).terminal;
    assert.equal(terminal.state, 'awaiting-attach');
    assert.equal(
      terminalCreateResponseSchema.parse(retry.value).terminal.terminalId,
      request.terminalId,
    );
    assert.equal(
      terminalListResponseSchema.parse((await context.request(path)).value).terminals.length,
      1,
    );
    const conflict = await context.request(path, 'POST', { ...request, cols: 90 });
    assert.equal(conflict.status, 409);
    assert.equal(errorSchema.parse(conflict.value).error.code, 'TERMINAL_ID_CONFLICT');
    const archive = await context.request(`/api/sessions/${context.sessionId}`, 'PATCH', {
      status: 'archived',
    });
    assert.equal(archive.status, 409);
    assert.equal(errorSchema.parse(archive.value).error.code, 'TERMINAL_ACTIVE');
    const deletion = await context.request(`/api/sessions/${context.sessionId}`, 'DELETE');
    assert.equal(deletion.status, 409);
    assert.equal(errorSchema.parse(deletion.value).error.code, 'TERMINAL_ACTIVE');
    const close = await context.request(`${path}/${request.terminalId}`, 'DELETE', { runtimeId });
    assert.equal(close.status, 200);
    assert.equal(terminalCloseResponseSchema.parse(close.value).state, 'closed');
    const lateCreate = await context.request(path, 'POST', request);
    assert.equal(lateCreate.status, 409);
    assert.equal(errorSchema.parse(lateCreate.value).error.code, 'TERMINAL_CLOSED');
    assert.equal(
      (await context.request(`/api/sessions/${context.sessionId}`, 'DELETE')).status,
      200,
    );
  } finally {
    await context.dispose();
  }
});

test('terminal HTTP routes retain pairing, Origin and CSRF checks, including one-use ticket creation', async () => {
  const context = await fixture();
  try {
    const { runtimeId } = terminalCapabilitiesSchema.parse(
      (await context.request('/api/terminals/capabilities')).value,
    );
    const path = `/api/sessions/${context.sessionId}/terminals`;
    const request = {
      runtimeId,
      terminalId: randomUUID(),
      expectedWorkspaceId: null,
      cols: 80,
      rows: 24,
    };
    const denied = await context.request(path, 'POST', request, {
      [desktopPairingHeader]: 'wrong',
    });
    assert.equal(denied.status, 403);
    assert.equal(errorSchema.parse(denied.value).error.code, 'DESKTOP_PAIRING_REQUIRED');
    assert.equal(
      (await context.request(path, 'POST', request, { Origin: 'https://example.invalid' })).status,
      403,
    );
    assert.equal(
      (await context.request(path, 'POST', request, { 'X-Atelier-Token': 'wrong' })).status,
      403,
    );
    assert.equal((await context.request(path, 'POST', request)).status, 200);
    assert.equal(
      (
        await context.request(
          `${path}/${request.terminalId}/attach-ticket`,
          'POST',
          { runtimeId },
          { Origin: '' },
        )
      ).status,
      403,
    );
    const stale = await context.request(path, 'POST', { ...request, runtimeId: randomUUID() });
    assert.equal(stale.status, 409);
    assert.equal(errorSchema.parse(stale.value).error.code, 'TERMINAL_RUNTIME_CHANGED');
  } finally {
    await context.dispose();
  }
});

test('paired HTTP plus WebSocket starts one real shell and reconnects without replaying input', async () => {
  const context = await fixture();
  const sockets: WebSocket[] = [];
  try {
    const { runtimeId } = terminalCapabilitiesSchema.parse(
      (await context.request('/api/terminals/capabilities')).value,
    );
    const path = `/api/sessions/${context.sessionId}/terminals`;
    const terminalId = randomUUID();
    const created = await context.request(path, 'POST', {
      runtimeId,
      terminalId,
      expectedWorkspaceId: null,
      cols: 80,
      rows: 24,
    });
    assert.equal(created.status, 200);
    const connect = async () => {
      const ticket = terminalTicketResponseSchema.parse(
        (await context.request(`${path}/${terminalId}/attach-ticket`, 'POST', { runtimeId })).value,
      );
      const socket = new WebSocket(
        context.origin.replace('http:', 'ws:') + ticket.streamPath,
        [ticket.protocol, `ticket.${ticket.ticket}`],
        { origin: context.origin },
      );
      sockets.push(socket);
      const peer = new TerminalPeer(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      assert.equal(socket.protocol, 'atelier-terminal.v1');
      return { peer, ticket };
    };
    const { peer: first, ticket: usedTicket } = await connect();
    const snapshot = await first.wait((frame) => frame.type === 'snapshot');
    assert.equal(snapshot.type, 'snapshot');
    if (snapshot.type !== 'snapshot') throw new Error('missing snapshot');
    assert.equal(snapshot.terminal.state, 'awaiting-attach');
    first.socket.send(
      JSON.stringify({ type: 'ready', attachmentId: snapshot.attachmentId, seq: snapshot.seq }),
    );
    const ready = await first.wait((frame) => frame.type === 'readyAccepted');
    assert.equal(ready.type === 'readyAccepted' && ready.writable, true);
    first.socket.send(
      JSON.stringify({
        type: 'input',
        attachmentId: snapshot.attachmentId,
        inputSeq: 1,
        payload: {
          encoding: 'utf8',
          data: "printf 'terminal-%s\\n' '真实PTY'; export ATELIER_TEST_COUNT=1\r",
        },
      }),
    );
    await first.wait((frame) => frame.type === 'output' && frame.data.includes('terminal-真实PTY'));
    // A browser cannot reuse a consumed ticket even while the original connection is alive.
    const replay = new WebSocket(
      context.origin.replace('http:', 'ws:') + usedTicket.streamPath,
      [usedTicket.protocol, `ticket.${usedTicket.ticket}`],
      { origin: context.origin },
    );
    sockets.push(replay);
    const replayStatus = await new Promise<number>((resolve, reject) => {
      replay.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      replay.once('open', () => reject(new Error('reused ticket accepted')));
      replay.once('error', () => {});
    });
    assert.equal(replayStatus, 403);
    const closed = new Promise<void>((resolve) => first.socket.once('close', () => resolve()));
    first.socket.close();
    await closed;
    const { peer: second } = await connect();
    const resumed = await second.wait((frame) => frame.type === 'snapshot');
    assert.equal(resumed.type, 'snapshot');
    if (resumed.type !== 'snapshot') throw new Error('missing resumed snapshot');
    assert.match(resumed.screen, /terminal-真实PTY/u);
    assert.equal(resumed.terminal.state, 'running');
    second.socket.send(
      JSON.stringify({ type: 'ready', attachmentId: resumed.attachmentId, seq: resumed.seq }),
    );
    await second.wait((frame) => frame.type === 'readyAccepted');
    second.socket.send(
      JSON.stringify({
        type: 'input',
        attachmentId: resumed.attachmentId,
        inputSeq: 1,
        payload: { encoding: 'utf8', data: 'printf \'retained-%s\\n\' "$ATELIER_TEST_COUNT"\r' },
      }),
    );
    await second.wait((frame) => frame.type === 'output' && frame.data.includes('retained-1'));
    const close = await context.request(`${path}/${terminalId}`, 'DELETE', { runtimeId });
    assert.equal(terminalCloseResponseSchema.parse(close.value).state, 'closed');
  } finally {
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await context.dispose();
  }
});
