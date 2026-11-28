/**
 * @file 验证提示词增强 HTTP 路由及其模型和持久化边界。
 * @implementation 用真实运行时、临时数据库和可控回环网关覆盖完整响应、限时和断开。
 * @updated 2026-11-28T18:00:00+08:00
 */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { createApp } from '../server/app.js';

test('enhancement sends only the draft to the default model and leaves session state untouched', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-text-enhancement-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: unknown[] = [];
  let reply: unknown;
  let hang = false;
  const upstream = new EventEmitter();
  const gateway = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.end('{}');
      return;
    }
    req.setEncoding('utf8');
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
    if (hang) {
      res.once('close', () => upstream.emit('disconnected'));
      upstream.emit('arrived');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    gateway.closeAllConnections();
    return new Promise<void>((resolve) => gateway.close(() => resolve()));
  });
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === 'object');
  const app = await createApp({ root: directory, data: directory });
  t.after(() => app.close());
  app.store.setConfig({
    ...app.store.config(),
    gateway: `http://127.0.0.1:${gatewayAddress.port}/v1`,
    model: 'workbench-primary',
    managedGateway: false,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const { csrfToken } = z
    .object({ csrfToken: z.string() })
    .parse(await fetch(origin + '/api/bootstrap').then((res) => res.json()));
  const source = '  先只读检查 ./x.ts，保留 `git status`  ';
  const request = (signal?: AbortSignal, input: unknown = { kind: 'instruction', text: source }) =>
    fetch(origin + '/api/text-enhancements', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-atelier-token': csrfToken },
      body: JSON.stringify(input),
      signal,
    });
  const result = (text: string, stop_reason = 'end_turn') => ({
    stop_reason,
    content: [{ type: 'text', text }],
  });
  reply = result('先只读检查 ./x.ts，执行 `git status` 后汇报。');
  const success = await request();
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { text: '先只读检查 ./x.ts，执行 `git status` 后汇报。' });
  const sent = z
    .object({
      url: z.literal('/v1/messages'),
      auth: z.string().startsWith('Bearer '),
      body: z.strictObject({
        model: z.literal('workbench-primary'),
        system: z.string(),
        max_tokens: z.number(),
        messages: z.array(z.strictObject({ role: z.literal('user'), content: z.string() })),
      }),
    })
    .parse(calls[0]);
  assert.deepEqual(sent.body.messages, [{ role: 'user', content: source }]);
  assert.match(sent.body.system, /read-only/i);
  reply = {
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: 'private reasoning' },
      { type: 'text', text: '保留 `git ' },
      { type: 'redacted_thinking', data: 'private' },
      { type: 'text', text: 'status`。' },
    ],
  };
  const multipleBlocks = await request();
  assert.equal(multipleBlocks.status, 200);
  assert.deepEqual(await multipleBlocks.json(), { text: '保留 `git status`。' });
  for (const response of [
    result(' '),
    result('incomplete', 'max_tokens'),
    result('x'.repeat(32_001)),
    { content: [{ type: 'text', text: 'missing completion reason' }] },
    { stop_reason: 'end_turn', content: [{ type: 'tool_use' }] },
  ]) {
    reply = response;
    const invalid = await request();
    assert.equal(invalid.status, 502);
    assert.equal((await invalid.json()).error.code, 'TEXT_ENHANCEMENT_INVALID');
  }
  const beforeInvalid = calls.length;
  for (const input of [
    { kind: 'instruction', text: ' ' },
    { kind: 'commit', text: 'draft' },
    { kind: 'instruction', text: 'draft', history: ['private'] },
  ]) {
    const invalid = await request(undefined, input);
    assert.equal(invalid.status, 400);
    await invalid.json();
  }
  assert.equal(calls.length, beforeInvalid);
  hang = true;
  const controller = new AbortController();
  const arrived = once(upstream, 'arrived');
  const disconnected = once(upstream, 'disconnected');
  const pending = assert.rejects(request(controller.signal), { name: 'AbortError' });
  await arrived;
  controller.abort();
  await pending;
  await disconnected;

  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const shorten = t.mock.method(AbortSignal, 'timeout', (ms: number) =>
    timeout(ms === 30_000 ? 35 : ms),
  );
  const timedOut = await request();
  assert.equal(timedOut.status, 504);
  assert.equal((await timedOut.json()).error.code, 'TEXT_ENHANCEMENT_TIMEOUT');
  assert.ok(shorten.mock.calls.some(({ arguments: args }) => args[0] === 30_000));
  for (const table of ['sessions', 'messages', 'runs', 'pending_messages'])
    assert.deepEqual(app.store.db.prepare(`SELECT count(*) AS total FROM ${table}`).get(), {
      total: 0,
    });
});
