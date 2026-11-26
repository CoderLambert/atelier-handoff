/**
 * @file 验证人工终端 WebSocket 的真实接入边界。
 * @implementation 通过本机 TCP 检查一次性票据、Origin、协议校验、客户端应答和升级连接释放。
 * @updated 2026-11-26T01:00:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import headless from '@xterm/headless';
import { TerminalManager } from '../server/modules/terminal/manager.js';
import { registerTerminalTransport } from '../server/modules/terminal/transport.js';
import {
  terminalProtocol,
  terminalServerFrameSchema,
  terminalStreamPath,
  type TerminalServerFrame,
} from '../shared/terminal.js';
import { AppError } from '../shared/types.js';
import { terminalFixture } from './fixtures/terminal-fixture.js';
import { processDoubleProvider, until } from './fixtures/terminal-process-double.js';

async function fixture() {
  const f = await terminalFixture();
  const fake = processDoubleProvider();
  const manager = new TerminalManager({
    store: f.store,
    worktrees: f.worktrees,
    supported: true,
    isSessionDeleting: () => false,
    processProvider: fake.provider,
  });
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  let origin = '';
  const transport = registerTerminalTransport(server, manager, {
    validateUpgrade(req) {
      if (req.headers.origin !== origin || req.headers.host !== new URL(origin).host)
        throw new AppError('ORIGIN_DENIED', 'denied', 403);
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  origin = 'http://127.0.0.1:' + address.port;
  const runtimeId = manager.capabilities().runtimeId;
  const terminalId = randomUUID();
  await manager.create(f.session.id, {
    runtimeId,
    terminalId,
    expectedWorkspaceId: null,
    cols: 80,
    rows: 24,
  });
  const ticket = () => manager.ticket(f.session.id, runtimeId, terminalId, origin).ticket;
  const url = origin.replace('http:', 'ws:') + terminalStreamPath;
  return {
    ...f,
    ...fake,
    manager,
    transport,
    server,
    origin,
    url,
    ticket,
    runtimeId,
    terminalId,
    async dispose() {
      await manager.shutdown();
      await transport.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.dispose();
    },
  };
}
async function denied(url: string, ticket: string, origin: string) {
  const socket = new WebSocket(url, [terminalProtocol, 'ticket.' + ticket], { origin });
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.terminate();
      reject(new Error('Unauthorized upgrade succeeded'));
    });
    socket.once('unexpected-response', (_req, res) => {
      try {
        assert.equal(res.statusCode, 403);
        res.resume();
        socket.terminate();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

test(
  'WS requires the signed HTTP origin, consumes a ticket once, and shuts down upgraded sockets',
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const ticket = f.ticket();
      await denied(f.url, ticket, 'http://attacker.invalid');
      const socket = new WebSocket(f.url, [terminalProtocol, 'ticket.' + ticket], {
        origin: f.origin,
      });
      const frames: TerminalServerFrame[] = [];
      socket.on('message', (data) =>
        frames.push(terminalServerFrameSchema.parse(JSON.parse(data.toString()))),
      );
      await once(socket, 'open');
      assert.equal(socket.protocol, terminalProtocol);
      await until(() => frames.some((frame) => frame.type === 'snapshot'));
      assert.equal(f.processes.length, 0);
      const snapshot = frames.find((frame) => frame.type === 'snapshot');
      assert.ok(snapshot);
      socket.send(
        JSON.stringify({ type: 'ready', attachmentId: snapshot.attachmentId, seq: snapshot.seq }),
      );
      await until(() => frames.some((frame) => frame.type === 'readyAccepted'));
      assert.equal(f.processes.length, 1);
      await denied(f.url, ticket, f.origin);
      const closed = once(socket, 'close');
      await f.transport.dispose();
      await closed;
      assert.equal(socket.readyState, WebSocket.CLOSED);
    } finally {
      await f.dispose();
    }
  },
);

test(
  'attached query is answered once by the client and malformed input closes only its connection',
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    const renderer = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      const socket = new WebSocket(f.url, [terminalProtocol, 'ticket.' + f.ticket()], {
        origin: f.origin,
      });
      let attachmentId = '';
      let inputSeq = 0;
      let writable = false;
      const errors: string[] = [];
      renderer.onData((data) => {
        if (writable)
          socket.send(
            JSON.stringify({
              type: 'input',
              attachmentId,
              inputSeq: ++inputSeq,
              payload: { encoding: 'utf8', data },
            }),
          );
      });
      socket.on('message', (data) => {
        const frame = terminalServerFrameSchema.parse(JSON.parse(data.toString()));
        if (frame.type === 'snapshot') {
          attachmentId = frame.attachmentId;
          renderer.write(frame.screen, () =>
            socket.send(JSON.stringify({ type: 'ready', attachmentId, seq: frame.seq })),
          );
        } else if (frame.type === 'readyAccepted') writable = frame.writable;
        else if (frame.type === 'output')
          renderer.write(frame.data, () =>
            socket.send(JSON.stringify({ type: 'outputAck', attachmentId, seq: frame.seq })),
          );
        else if (frame.type === 'error') errors.push(frame.code);
      });
      await until(() => writable);
      const process = f.processes[0];
      assert.ok(process);
      process.output('\u001b[6n');
      await until(() => process.writes.length > 0);
      assert.deepEqual(process.writes, ['\u001b[1;1R']);
      const closed = once(socket, 'close');
      socket.send(
        JSON.stringify({
          type: 'input',
          attachmentId,
          inputSeq: 99,
          payload: { encoding: 'utf8', data: 'must not execute' },
        }),
      );
      await closed;
      assert.ok(errors.includes('TERMINAL_PROTOCOL_ERROR'));
      assert.deepEqual(process.writes, ['\u001b[1;1R']);
      assert.equal(f.manager.list(f.session.id).terminals[0]?.state, 'running');
    } finally {
      renderer.dispose();
      await f.dispose();
    }
  },
);
