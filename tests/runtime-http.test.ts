/**
 * @file 验证拆分后的运行时仍协调 HTTP 关停与持久回执。
 * @implementation 用真实 HTTP/SSE 与临时 SQLite 检查长连接关闭、目录选择取消、回执回滚与按会话清理。
 * @updated 2026-11-27T00:01:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';

async function withData<T>(work: (data: string) => Promise<T> | T): Promise<T> {
  const data = await mkdtemp(join(tmpdir(), 'atelier-runtime-http-test-'));
  try {
    return await work(data);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
}

test(
  'closing the runtime cancels the pending picker and ends the live event stream',
  { timeout: 8_000 },
  async () =>
    withData(async (data) => {
      let markPicked: (signal: AbortSignal) => void;
      const picked = new Promise<AbortSignal>((resolve) => {
        markPicked = resolve;
      });
      const app = await createApp({
        root: process.cwd(),
        data,
        pickDirectory: (signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve(null), { once: true });
            markPicked(signal);
          }),
      });
      const signal = AbortSignal.timeout(5_000);
      try {
        await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
        const address = app.server.address();
        assert.ok(address && typeof address === 'object');
        const origin = `http://127.0.0.1:${address.port}`;
        const bootstrap = await fetch(origin + '/api/bootstrap', { signal });
        const { csrfToken } = z.object({ csrfToken: z.string() }).parse(await bootstrap.json());
        const stream = await fetch(origin + '/api/events', { signal });
        assert.equal(stream.status, 200);
        assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream/);
        const streamContent = stream.text();
        const picker = fetch(origin + '/api/projects/pick-directory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': csrfToken },
          body: '{}',
          signal,
        }).then(async (response) => {
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), { path: null });
        });
        const pickerSignal = await Promise.race([
          picked,
          picker.then(() => {
            throw new Error('picker did not start');
          }),
        ]);
        const close = app.close();
        assert.equal(app.close(), close);
        await Promise.all([picker, close]);
        assert.equal(pickerSignal.aborted, true);
        assert.match(await streamContent, /^: connected/m);
        assert.equal(app.server.listening, false);
        assert.equal(app.store.events.listenerCount('event'), 0);
      } finally {
        await app.close();
      }
    }),
);

test('run receipts and session event cleanup use the same write transaction', async () =>
  withData((data) => {
    const store = new Store(data);
    try {
      const session = randomUUID();
      const other = randomUUID();
      const request = randomUUID();
      const key = `${session}:${request}`;
      const otherKey = `${other}:${request}`;
      const run = randomUUID();
      store.transaction(() => {
        store.runReceipts.insert(key, 'fixture-hash', run);
        store.runReceipts.insert(otherKey, 'other-hash', randomUUID());
        store.event(run, session, 'fixture.first');
        store.event(randomUUID(), other, 'fixture.second');
      });
      const remove = () => {
        store.sessionEvents.deleteForSession(session);
        store.runReceipts.deleteForSession(session);
      };
      assert.throws(
        () =>
          store.transaction(() => {
            remove();
            throw new Error('cancel the fixture transaction');
          }),
        /cancel the fixture transaction/,
      );
      assert.deepEqual(store.runReceipts.find(key), { bodyHash: 'fixture-hash', runId: run });
      assert.equal(store.history(session).length, 1);
      store.transaction(remove);
      assert.equal(store.runReceipts.find(key), undefined);
      assert.equal(store.history(session).length, 0);
      assert.equal(store.runReceipts.find(otherKey)?.bodyHash, 'other-hash');
      assert.equal(store.history(other).length, 1);
    } finally {
      store.close();
    }
  }));
