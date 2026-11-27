/**
 * @file 接入人工终端的 WebSocket 数据流。
 * @implementation 在现有 HTTP server 上验证单次票据与 Origin，限制入站帧、复用预序列化下行字符串并维持心跳和停滞断开。
 * @updated 2026-11-27T22:10:00+08:00
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { terminalLimits, terminalProtocol, terminalStreamPath } from '../../../shared/terminal.js';
import { AppError } from '../../../shared/errors.js';
import type { TerminalAttachment, TerminalConnection, TerminalManager } from './manager.js';

export function registerTerminalTransport(
  server: Server,
  manager: TerminalManager,
  options: { validateUpgrade(req: IncomingMessage): void },
): { dispose(): Promise<void> } {
  const sockets = new Set<Duplex>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: terminalLimits.frameBytes,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(terminalProtocol) ? terminalProtocol : false),
  });
  let disposing = false;
  let disposal: Promise<void> | undefined;
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    sockets.add(socket);
    const timeout = setTimeout(() => socket.destroy(), 5000);
    timeout.unref();
    socket.once('close', () => {
      clearTimeout(timeout);
      sockets.delete(socket);
    });
    try {
      if (disposing) throw new Error('Closed');
      if (
        req.method !== 'GET' ||
        new URL(req.url ?? '/', 'http://localhost').pathname !== terminalStreamPath
      )
        throw new Error('Path');
      options.validateUpgrade(req);
      const origin = req.headers.origin;
      if (!origin || new URL(origin).origin !== origin) throw new Error('Origin');
      const protocols =
        req.headers['sec-websocket-protocol']?.split(',').map((value) => value.trim()) ?? [];
      if (protocols.length !== 2 || !protocols.includes(terminalProtocol))
        throw new Error('Protocol');
      const proof = protocols.find((value) => /^ticket\.[a-f0-9]{64}$/u.test(value));
      if (!proof) throw new Error('Ticket');
      const target = manager.consumeTicket(proof.slice('ticket.'.length), origin);
      wss.handleUpgrade(req, socket, head, (ws) => {
        clearTimeout(timeout);
        sockets.delete(socket);
        let attachment: TerminalAttachment | undefined;
        let forceClose: ReturnType<typeof setTimeout> | undefined;
        let pongAt = Date.now();
        let incomingBytes = 0;
        const connection: TerminalConnection = {
          get bufferedAmount() {
            return ws.bufferedAmount;
          },
          send(frame, encoded) {
            if (ws.readyState !== WebSocket.OPEN) throw new Error('Disconnected');
            ws.send(encoded ?? JSON.stringify(frame));
          },
          close(code) {
            if (ws.readyState === WebSocket.OPEN) ws.close(1008, code);
            forceClose ??= setTimeout(() => ws.terminate(), 500);
            forceClose.unref();
          },
        };
        const fail = (code: string) => {
          if (attachment) {
            try {
              connection.send({ type: 'error', attachmentId: attachment.attachmentId, code });
            } catch {
              /* Peer already closed. */
            }
            attachment.detach();
          }
          connection.close(code);
        };
        const heartbeat = setInterval(() => {
          if (Date.now() - pongAt >= terminalLimits.heartbeatTimeoutMs) {
            fail('TERMINAL_CONNECTION_LOST');
            return;
          }
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, terminalLimits.heartbeatMs);
        heartbeat.unref();
        ws.on('pong', () => {
          pongAt = Date.now();
        });
        ws.on('error', () => attachment?.detach());
        ws.once('close', () => {
          clearTimeout(forceClose);
          clearInterval(heartbeat);
          attachment?.detach();
        });
        try {
          attachment = manager.attach(target.sessionId, target.terminalId, connection);
        } catch (error) {
          fail(error instanceof AppError ? error.code : 'TERMINAL_CONNECTION_LOST');
        }
        ws.on('message', (data, isBinary) => {
          if (!attachment || isBinary) {
            fail('TERMINAL_PROTOCOL_ERROR');
            return;
          }
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data);
          incomingBytes += bytes.byteLength;
          if (incomingBytes > terminalLimits.frameBytes * 2) {
            fail('TERMINAL_PROTOCOL_ERROR');
            return;
          }
          let value: unknown;
          try {
            value = JSON.parse(bytes.toString('utf8'));
          } catch {
            incomingBytes -= bytes.byteLength;
            fail('TERMINAL_PROTOCOL_ERROR');
            return;
          }
          void attachment
            .receive(value)
            .catch((error: unknown) =>
              fail(error instanceof AppError ? error.code : 'TERMINAL_PROTOCOL_ERROR'),
            )
            .finally(() => {
              incomingBytes -= bytes.byteLength;
            });
        });
      });
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  };
  server.on('upgrade', upgrade);
  return {
    dispose() {
      if (disposal) return disposal;
      disposing = true;
      server.off('upgrade', upgrade);
      for (const socket of sockets) socket.destroy();
      disposal = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          for (const ws of wss.clients) ws.terminate();
        }, 250);
        for (const ws of wss.clients) ws.close(1001, 'TERMINAL_SHUTDOWN');
        wss.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
      return disposal;
    },
  };
}
