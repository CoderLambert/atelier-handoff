/**
 * @file 为工作台提供可重连的运行事件流。
 * @implementation 先验证或重置游标，再按事件 ID 回放和订阅，断连后释放监听与心跳。
 * @updated 2026-11-26T23:20:03+08:00
 */
import type { ServerResponse } from 'node:http';
import type { RunEvent } from '../../../shared/types.js';
import type { Store } from '../../store.js';
import type { RouteHandler } from '../types.js';

export function createEventRoutes(
  store: Pick<Store, 'cursor' | 'events' | 'since'>,
  streams: Set<ServerResponse>,
): RouteHandler {
  return ({ req, res, url, method }) => {
    if (url.pathname !== '/api/events' || method !== 'GET') return false;
    const requested = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
    const latest = store.cursor();
    const reset = !Number.isSafeInteger(requested) || requested < 0 || requested > latest;
    let cursor = reset ? latest : requested;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    if (reset)
      res.write(`id: ${cursor}\nevent: cursor-reset\ndata: ${JSON.stringify({ cursor })}\n\n`);
    streams.add(res);
    const send = (event: RunEvent) => {
      if (event.id <= cursor) return;
      cursor = event.id;
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    store.events.on('event', send);
    while (true) {
      const events = store.since(cursor);
      events.forEach(send);
      if (events.length < 1000) break;
    }
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    res.once('close', () => {
      clearInterval(heartbeat);
      store.events.off('event', send);
      streams.delete(res);
    });
    return true;
  };
}
