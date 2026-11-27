/**
 * @file 验证托管 Shunt 转发的标识、流式响应和取消边界。
 * @implementation 用隔离 HTTP 上游检查认证、并发请求标识唯一性、原标识保留及错误和压缩响应透传，取消后核对两端连接释放。
 * @updated 2026-11-27T12:28:51+08:00
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { openManagedShuntRequestIds } from '../server/managed-shunt-request-ids.js';
import type { AppConfig } from '../shared/types.js';

test(
  'managed relay supplies distinct response IDs without changing compressed bytes or request lifecycle',
  { timeout: 8000 },
  async () => {
    const credentials = 'synthetic-managed-token';
    const received: string[] = [];
    let onCancel = () => {};
    const canceled = new Promise<void>((resolve) => {
      onCancel = resolve;
    });
    const upstream = createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      received.push(text);
      if (req.url?.includes('cancel')) {
        res.once('close', onCancel);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ready\n\n');
        return;
      }
      if (req.url?.includes('retry')) {
        res.writeHead(429, { 'Retry-After': '1' }).end('retry');
        return;
      }
      if (req.url?.includes('slow')) await delay(90);
      const encoded = gzipSync(text);
      res
        .writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Content-Encoding': 'gzip',
          'Content-Length': encoded.length,
          Connection: 'x-hop-test',
          'x-hop-test': 'drop-me',
          ...(text === 'existing' && { 'request-id': 'req_original' }),
        })
        .end(encoded);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    assert.ok(address && typeof address !== 'string');
    const gateway = `http://127.0.0.1:${address.port}`;
    const previousGateway = process.env.ATELIER_MANAGED_GATEWAY;
    const previousToken = process.env.ATELIER_MANAGED_GATEWAY_TOKEN;
    process.env.ATELIER_MANAGED_GATEWAY = gateway;
    process.env.ATELIER_MANAGED_GATEWAY_TOKEN = credentials;
    const config: AppConfig = {
      gateway,
      model: 'fixture',
      managedGateway: true,
      maxTurns: 8,
      timeoutMs: 8000,
    };
    const stop = new AbortController();
    const relay = await openManagedShuntRequestIds(config, credentials, stop.signal);
    assert.ok(relay);
    try {
      assert.equal(
        await openManagedShuntRequestIds(
          { ...config, managedGateway: false },
          credentials,
          stop.signal,
        ),
        undefined,
      );
      assert.equal((await fetch(relay.origin + '/v1/messages', { method: 'POST' })).status, 404);
      assert.deepEqual(received, []);
      const call = (body: string, path = '') =>
        fetch(relay.origin + '/v1/messages' + path, {
          method: 'POST',
          headers: { 'x-api-key': credentials },
          body,
        });
      const retry = await call('retry', '?retry');
      assert.equal(retry.status, 429);
      assert.equal(retry.headers.get('request-id'), null);
      assert.equal(await retry.text(), 'retry');
      const [slow, fast] = await Promise.all([call('slow', '?slow'), call('fast')]);
      assert.notEqual(slow.headers.get('request-id'), fast.headers.get('request-id'));
      for (const [response, text] of [
        [slow, 'slow'],
        [fast, 'fast'],
      ] as const) {
        assert.match(response.headers.get('request-id') ?? '', /^req_atelier_[a-f0-9-]{36}$/u);
        assert.equal(response.headers.get('x-hop-test'), null);
        assert.equal(response.headers.get('content-encoding'), 'gzip');
        assert.equal(await response.text(), text);
      }
      const existing = await call('existing');
      assert.equal(existing.headers.get('request-id'), 'req_original');
      assert.equal(await existing.text(), 'existing');
      const count = await call('count', '/count_tokens');
      assert.equal(count.headers.get('request-id'), null);
      assert.equal(await count.text(), 'count');
      const streaming = await call('cancel', '?cancel');
      assert.ok(streaming.body);
      const reader = streaming.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: ready\n\n');
      stop.abort();
      await canceled;
      await assert.rejects(reader.read());
      await assert.rejects(call('closed'));
    } finally {
      await relay.close();
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
      if (previousGateway === undefined) delete process.env.ATELIER_MANAGED_GATEWAY;
      else process.env.ATELIER_MANAGED_GATEWAY = previousGateway;
      if (previousToken === undefined) delete process.env.ATELIER_MANAGED_GATEWAY_TOKEN;
      else process.env.ATELIER_MANAGED_GATEWAY_TOKEN = previousToken;
    }
  },
);
