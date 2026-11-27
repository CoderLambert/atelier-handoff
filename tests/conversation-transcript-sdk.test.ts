/**
 * @file 验证真实 SDK 会话顺序、流式文本和模型请求计时。
 * @implementation 使用隔离 HTTP 工作台与回环模型验证混合正文工具、恢复、停止及错误，核对重试只记运行事件、请求与流的计时及脱敏诊断。
 * @updated 2026-11-27T14:21:24+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { desktopPairingHeader } from '../shared/desktop-host.js';
import type {
  Message,
  Permission,
  Run,
  RunEvent,
  SendSessionMessageResult,
  ToolCall,
} from '../shared/types.js';

type Block =
  | { text: string }
  | { id: string; command: string }
  | { id: string; name: string; input: Record<string, unknown> };
async function reply(response: ServerResponse, model: string, blocks: Block[], staged = false) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': randomUUID() });
  const usage = {
    input_tokens: 12,
    output_tokens: blocks.length,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const send = (type: string, values: object = {}) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...values })}\n\n`);
  send('message_start', {
    message: {
      id: 'msg_' + randomUUID(),
      role: 'assistant',
      type: 'message',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...usage, output_tokens: 0 },
    },
  });
  if (staged) await delay(140);
  blocks.forEach((block, index) => {
    if ('text' in block) {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      // More than one delta proves the stable part is updated rather than duplicated.
      const middle = Math.max(1, Math.floor(block.text.length / 2));
      for (const text of [block.text.slice(0, middle), block.text.slice(middle)])
        send('content_block_delta', { index, delta: { type: 'text_delta', text } });
    } else {
      send('content_block_start', {
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: 'name' in block ? block.name : 'Bash',
          input: {},
        },
      });
      send('content_block_delta', {
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(
            'input' in block
              ? block.input
              : {
                  command: block.command,
                  description: 'Transcript order fixture',
                  timeout: 30_000,
                },
          ),
        },
      });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', {
    delta: {
      stop_reason: blocks.some((block) => !('text' in block)) ? 'tool_use' : 'end_turn',
      stop_sequence: null,
    },
    usage,
  });
  if (staged) await delay(140);
  send('message_stop');
  response.end();
}

test(
  'real SDK preserves every transcript entry, tool start order, typed notices and restart snapshots',
  { skip: process.platform !== 'linux', timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atelier-transcript-'));
    const project = join(directory, 'project');
    await mkdir(project);
    const oldToken = process.env.ATELIER_GATEWAY_TOKEN;
    process.env.ATELIER_GATEWAY_TOKEN = 'transcript-loopback';
    const model = 'fixture-transcript';
    const attempts = new Map<string, number>();
    const gateway = createServer(async (request, response) => {
      if (request.method !== 'POST')
        return response.end(JSON.stringify({ data: [{ model, id: model }] }));
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = Buffer.concat(chunks).toString('utf8');
      const lane =
        [
          'ORDER_FIXTURE',
          'RETRY_FIXTURE',
          'ERROR_FIXTURE',
          'CANCEL_FIXTURE',
          'APPROVAL_FIXTURE',
          'BLOCKED_FIXTURE',
          'PREPARING_FIXTURE',
        ].find((marker) => wire.includes(marker)) ?? 'unknown';
      const attempt = (attempts.get(lane) ?? 0) + 1;
      attempts.set(lane, attempt);
      if (lane === 'ERROR_FIXTURE' || (lane === 'RETRY_FIXTURE' && attempt === 1)) {
        response.writeHead(lane === 'ERROR_FIXTURE' ? 400 : 429, {
          'content-type': 'application/json',
          'retry-after': '0',
        });
        return response.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: lane === 'ERROR_FIXTURE' ? 'invalid_request_error' : 'rate_limit_error',
              message: 'Synthetic loopback fixture',
            },
          }),
        );
      }
      if (lane === 'PREPARING_FIXTURE' && attempt === 1) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'request-id': randomUUID(),
        });
        const send = (type: string, values: object = {}) =>
          response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...values })}\n\n`);
        send('message_start', {
          message: {
            id: 'msg_preparing_' + randomUUID(),
            role: 'assistant',
            type: 'message',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 0 },
          },
        });
        send('content_block_start', {
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_preparing', name: 'Bash', input: {} },
        });
        send('content_block_delta', {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"printf' },
        });
        // The actual SDK must surface this frame before JSON input or assistant message completion.
        return;
      }
      if (lane === 'BLOCKED_FIXTURE' && attempt === 1)
        return reply(response, model, [
          { text: 'TRANSCRIPT_BEFORE_BLOCK' },
          { id: 'toolu_blocked', command: "printf 'MUST_NOT_RUN'" },
        ]);
      if (lane === 'APPROVAL_FIXTURE' && attempt === 1)
        return reply(response, model, [
          { text: 'TRANSCRIPT_BEFORE_APPROVAL' },
          {
            id: 'toolu_approval',
            name: 'mcp__atelier__write_file',
            input: {
              path: 'approval.txt',
              content: 'synthetic',
              reason: 'Transcript approval test',
            },
          },
        ]);
      if ((lane === 'ORDER_FIXTURE' || lane === 'CANCEL_FIXTURE') && attempt === 1) {
        const suffix = lane === 'CANCEL_FIXTURE' ? '-cancel' : '';
        return reply(response, model, [
          { text: 'TRANSCRIPT_INTRO 😀' },
          {
            id: 'toolu_order_first',
            command: `printf 'FIRST_START\\n'; while ! test -f release-first${suffix}; do sleep 0.05; done; printf 'FIRST_END\\n'`,
          },
          { text: 'TRANSCRIPT_BETWEEN' },
          {
            id: 'toolu_order_second',
            command: `printf 'SECOND_START\\n'; while ! test -f release-second${suffix}; do sleep 0.05; done; printf 'SECOND_END\\n'`,
          },
        ]);
      }
      if (lane === 'ORDER_FIXTURE') await delay(140);
      await reply(
        response,
        model,
        lane === 'ORDER_FIXTURE'
          ? Array.from({ length: 505 }, (_, index) => ({
              text: `TRANSCRIPT_FINAL_${String(index).padStart(3, '0')}`,
            }))
          : [{ text: 'TRANSCRIPT_RECOVERED' }],
        lane === 'ORDER_FIXTURE',
      );
    });
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    let base = '';
    const pairing = 'transcript-isolated';
    const headers: Record<string, string> = {
      [desktopPairingHeader]: pairing,
      'content-type': 'application/json',
    };
    async function request<T>(
      path: string,
      method = 'GET',
      payload?: unknown,
      status = 200,
    ): Promise<T> {
      const response = await fetch(base + path, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const value: unknown = await response.json();
      assert.equal(response.status, status, JSON.stringify(value));
      // Test-only HTTP client: assertions below validate each response field that is consumed.
      return value as T;
    }
    async function open() {
      app = await createApp({
        root: fileURLToPath(new URL('../', import.meta.url)),
        data: join(directory, 'data'),
        desktopPairing: pairing,
        nativeExecution: true,
      });
      app.server.listen(0, '127.0.0.1');
      await once(app.server, 'listening');
      const address = app.server.address();
      assert.ok(address && typeof address === 'object');
      base = 'http://127.0.0.1:' + address.port;
      headers['x-atelier-token'] = (
        await request<{ csrfToken: string }>('/api/bootstrap')
      ).csrfToken;
    }
    async function wait<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        const value = await read();
        if (value !== undefined) return value;
        await delay(30);
      }
      throw new Error('Timed out observing ' + label);
    }
    const trace = (id: string) => request<{ run: Run; tools: ToolCall[]; events: RunEvent[] }>('/api/runs/' + id);
    const snapshot = (id: string) =>
      request<{ messages: Message[]; runs: Run[]; tools: ToolCall[] }>('/api/sessions/' + id);
    try {
      gateway.listen(0, '127.0.0.1');
      await once(gateway, 'listening');
      const address = gateway.address();
      assert.ok(address && typeof address === 'object');
      await open();
      await request('/api/config', 'PATCH', {
        gateway: 'http://127.0.0.1:' + address.port,
        model,
        managedGateway: false,
      });
      const { project: bound } = await request<{ project: { id: string } }>(
        '/api/projects',
        'POST',
        { path: project },
        201,
      );
      async function start(
        text: string,
        executionPreference: 'native-v1' | 'project-v1' = 'native-v1',
      ) {
        const { session } = await request<{ session: { id: string } }>(
          '/api/sessions',
          'POST',
          { projectId: bound.id },
          201,
        );
        const { run } = await request<SendSessionMessageResult>(
          '/api/sessions/' + session.id + '/messages',
          'POST',
          { text, executionPreference, mode: 'edit', idempotencyKey: randomUUID() },
          202,
        );
        assert.ok(run);
        return { session: session.id, run: run.id };
      }
      const ordered = await start('ORDER_FIXTURE');
      const live = await wait(async () => {
        const current = await trace(ordered.run);
        return current.tools.length === 2 &&
          current.tools.every((tool) => tool.status === 'running')
          ? current
          : undefined;
      }, 'two parallel tools');
      const first = live.tools.find((tool) => tool.id.endsWith('toolu_order_first'));
      const second = live.tools.find((tool) => tool.id.endsWith('toolu_order_second'));
      assert.ok(first && second);
      assert.equal(live.run.transcript?.version, 1);
      assert.ok(first.transcriptOrder && second.transcriptOrder);
      assert.ok(first.transcriptOrder < second.transcriptOrder);
      const before = await snapshot(ordered.session);
      const liveAssistant = before.messages.find((message) => message.role === 'assistant');
      assert.ok(liveAssistant?.transcriptParts);
      const liveIdentity = liveAssistant.transcriptParts.map((part) => ({
        id: part.id,
        order: part.order,
      }));
      await writeFile(join(project, 'release-second'), '');
      await wait(
        async () =>
          (await trace(ordered.run)).tools.find(
            (tool) => tool.id === second.id && tool.endedAt !== null,
          ),
        'second tool completes first',
      );
      assert.equal(
        (await trace(ordered.run)).tools.find((tool) => tool.id === first.id)?.status,
        'running',
      );
      await writeFile(join(project, 'release-first'), '');
      await wait(
        async () => ((await trace(ordered.run)).run.status === 'completed' ? true : undefined),
        'ordered run completion',
      );
      const saved = await snapshot(ordered.session);
      const assistant = saved.messages.find((message) => message.id === liveAssistant.id);
      assert.ok(assistant?.transcriptParts);
      const parts = assistant.transcriptParts;
      assert.equal(
        parts.length,
        507,
        'all 505 consecutive final blocks plus two earlier texts survive',
      );
      assert.deepEqual(
        parts.slice(0, 2).map((part) => ({ id: part.id, order: part.order })),
        liveIdentity,
      );
      const texts = parts.map((part) => assistant.text.slice(part.start, part.end));
      assert.deepEqual(texts.slice(0, 2), ['TRANSCRIPT_INTRO 😀', 'TRANSCRIPT_BETWEEN']);
      assert.deepEqual(
        texts.slice(2),
        Array.from(
          { length: 505 },
          (_, index) => `TRANSCRIPT_FINAL_${String(index).padStart(3, '0')}`,
        ),
      );
      assert.equal(
        parts.map((part) => assistant.text.slice(part.start, part.end)).join('\n\n'),
        assistant.text,
      );
      assert.equal(new Set(parts.map((part) => part.id)).size, parts.length);
      const user = saved.messages.find((message) => message.role === 'user');
      assert.ok(user?.transcriptOrder);
      const intro = parts[0],
        middle = parts[1],
        final = parts[2];
      assert.ok(intro && middle && final);
      assert.ok(
        user.transcriptOrder < intro.order &&
          intro.order < first.transcriptOrder &&
          first.transcriptOrder < middle.order &&
          middle.order < second.transcriptOrder &&
          second.transcriptOrder < final.order,
      );
      const ended = await trace(ordered.run);
      const timing = ended.run.requestTiming;
      assert.ok(timing);
      const streams = timing.records.flatMap(({ stream }) => (stream ? [stream] : []));
      assert.equal(streams.length, 2, JSON.stringify(timing));
      const followup = streams[1];
      assert.ok(followup?.lastToolFinishedAt);
      assert.equal(timing.records.length, 2, JSON.stringify(timing));
      const span = timing.records.find(({ stream }) => stream === followup)?.request;
      assert.ok(span, JSON.stringify(timing));
      assert.ok(span.startedAt >= followup.lastToolFinishedAt);
      assert.ok((span.ttftMs ?? 0) >= 125);
      assert.ok((span.firstContentMs ?? 0) >= 245);
      assert.ok(span.durationMs >= 375);
      assert.equal(followup.outcome, 'complete');
      assert.ok(followup.firstEventAt - followup.lastToolFinishedAt >= 125);
      assert.ok((followup.firstContentAfterEventMs ?? 0) >= 120);
      assert.ok(followup.durationMs >= 250);
      const diagnostics = await request<{ requestTiming: typeof timing }>(
        '/api/runs/' + ordered.run + '/diagnostics.json',
      );
      assert.deepEqual(diagnostics.requestTiming, timing);
      assert.doesNotMatch(JSON.stringify(timing), /TRANSCRIPT_FINAL|toolu_order|msg_/);
      assert.equal(
        ended.tools.find((tool) => tool.id === first.id)?.transcriptOrder,
        first.transcriptOrder,
      );
      assert.equal(
        ended.tools.find((tool) => tool.id === second.id)?.transcriptOrder,
        second.transcriptOrder,
      );

      const retried = await start('RETRY_FIXTURE');
      await wait(
        async () => ((await trace(retried.run)).run.status === 'completed' ? true : undefined),
        'retry recovery',
      );
      const { run: retriedRun, events: retryEvents } = await trace(retried.run);
      const retry = retryEvents.find((event) => event.type === 'sdk.api_retry');
      assert.equal(retry?.payload.httpStatus, 429);
      assert.equal(retry?.payload.afterStopRequested, undefined);
      assert.ok(!retriedRun.transcript?.notices.some((notice) => notice.kind === 'api_retry'));
      assert.ok(retriedRun.requestTiming?.records.some(({ request }) => (request?.attempts ?? 0) > 1));
      assert.ok(attempts.get('RETRY_FIXTURE') === 2);
      const errored = await start('ERROR_FIXTURE');
      await wait(
        async () => ((await trace(errored.run)).run.status === 'failed' ? true : undefined),
        'terminal API error',
      );
      const erroredRun = (await trace(errored.run)).run;
      const failure = erroredRun.transcript?.notices.find((notice) => notice.kind === 'api_error');
      assert.ok(failure?.kind === 'api_error' && failure.code.length > 0);
      assert.ok(erroredRun.requestTiming?.records.some(({ request, stream }) => request?.failed && !stream));

      const approval = await start('APPROVAL_FIXTURE', 'project-v1');
      const awaiting = await wait(async () => {
        const current = await request<{ run: Run; tools: ToolCall[]; permissions: Permission[] }>(
          '/api/runs/' + approval.run,
        );
        return current.run.status === 'awaiting_permission' ? current : undefined;
      }, 'controlled write approval');
      const permission = awaiting.permissions.find((value) => value.status === 'pending');
      const approvedTool = awaiting.tools.find((tool) => tool.id === permission?.toolCallId);
      assert.ok(permission && approvedTool?.transcriptOrder);
      await request('/api/permissions/' + permission.id + '/decision', 'POST', {
        decision: 'deny',
        version: permission.version,
      });
      await wait(
        async () => ((await trace(approval.run)).run.status === 'completed' ? true : undefined),
        'denied tool follow-up',
      );
      const denied = await trace(approval.run);
      assert.equal(
        denied.tools.find((tool) => tool.id === approvedTool.id)?.transcriptOrder,
        approvedTool.transcriptOrder,
      );
      assert.equal(denied.tools.find((tool) => tool.id === approvedTool.id)?.status, 'denied');
      assert.equal(
        denied.run.transcript?.notices.some((notice) => notice.kind === 'tool_blocked'),
        false,
        'the denied tool card already owns the position',
      );
      const deniedDetail = await request<{ permissions: Permission[] }>(
        '/api/runs/' + approval.run,
      );
      assert.equal(
        deniedDetail.permissions.find((value) => value.id === permission.id)?.toolCallId,
        approvedTool.id,
      );
      assert.equal(
        deniedDetail.permissions.find((value) => value.id === permission.id)?.status,
        'denied',
      );
      const prohibited = await start('BLOCKED_FIXTURE', 'project-v1');
      await wait(
        async () => ((await trace(prohibited.run)).run.status === 'completed' ? true : undefined),
        'blocked tool follow-up',
      );
      const prohibitedDetail = await trace(prohibited.run);
      assert.equal(
        prohibitedDetail.tools.length,
        0,
        'blocked SDK native tool never executes in controlled mode',
      );
      const blocked = prohibitedDetail.run.transcript?.notices.find(
        (notice) => notice.kind === 'tool_blocked',
      );
      assert.ok(
        blocked?.kind === 'tool_blocked' && blocked.toolCallId.endsWith('toolu_blocked'),
        JSON.stringify(prohibitedDetail),
      );
      assert.equal(blocked.toolName, 'Bash');

      const preparingRun = await start('PREPARING_FIXTURE');
      const preparing = await wait(async () => {
        const current = await trace(preparingRun.run);
        const notice = current.run.transcript?.notices.find(
          (value) => value.kind === 'tool_preparing',
        );
        return notice?.kind === 'tool_preparing' ? { current, notice } : undefined;
      }, 'partial tool frame before JSON completion');
      assert.equal(preparing.current.tools.length, 0);
      assert.ok(preparing.notice.toolCallId.endsWith('toolu_preparing'));
      assert.equal(preparing.notice.toolName, 'Bash');
      await request('/api/runs/' + preparingRun.run + '/stop', 'POST', {});
      await wait(
        async () => ((await trace(preparingRun.run)).run.status === 'stopped' ? true : undefined),
        'partial frame cancellation',
      );
      const interruptedDetail = await trace(preparingRun.run);
      const interrupted = interruptedDetail.run.transcript?.notices.find(
        (value) => value.kind === 'tool_interrupted',
      );
      assert.ok(interrupted?.kind === 'tool_interrupted');
      assert.equal(interrupted.toolCallId, preparing.notice.toolCallId);
      assert.equal(interrupted.order, preparing.notice.order);
      assert.equal(interrupted.at, preparing.notice.at);
      assert.equal(interruptedDetail.tools.length, 0);
      assert.ok(
        interruptedDetail.run.requestTiming?.records.some(
          ({ stream }) => stream?.outcome === 'interrupted',
        ),
      );

      const canceled = await start('CANCEL_FIXTURE');
      const pending = await wait(async () => {
        const current = await trace(canceled.run);
        return current.tools.length === 2 &&
          current.tools.every((tool) => tool.status === 'running')
          ? current
          : undefined;
      }, 'cancel fixture tools');
      const canceledOrders = pending.tools.map((tool) => ({
        id: tool.id,
        order: tool.transcriptOrder,
      }));
      await request('/api/runs/' + canceled.run + '/stop', 'POST', {});
      await wait(
        async () => ((await trace(canceled.run)).run.status === 'stopped' ? true : undefined),
        'cancellation',
      );
      const stopped = await trace(canceled.run);
      assert.deepEqual(
        stopped.tools.map((tool) => ({ id: tool.id, order: tool.transcriptOrder })),
        canceledOrders,
      );
      assert.ok(stopped.tools.every((tool) => tool.endedAt !== null));

      const otherSessions = [
        preparingRun.session,
        retried.session,
        errored.session,
        approval.session,
        prohibited.session,
        canceled.session,
      ];
      const otherSnapshots = await Promise.all(otherSessions.map(snapshot));
      await app?.close();
      app = undefined;
      await open();
      assert.deepEqual(await Promise.all(otherSessions.map(snapshot)), otherSnapshots);
      const reopened = await snapshot(ordered.session);
      assert.deepEqual(reopened.messages, saved.messages);
      assert.deepEqual(
        reopened.runs.find((run) => run.id === ordered.run)?.transcript,
        saved.runs.find((run) => run.id === ordered.run)?.transcript,
      );
      assert.deepEqual(
        reopened.tools.map((tool) => ({ id: tool.id, order: tool.transcriptOrder })),
        saved.tools.map((tool) => ({ id: tool.id, order: tool.transcriptOrder })),
      );
    } finally {
      await app?.close();
      gateway.closeAllConnections();
      await new Promise<void>((done) => gateway.close(() => done()));
      if (oldToken === undefined) delete process.env.ATELIER_GATEWAY_TOKEN;
      else process.env.ATELIER_GATEWAY_TOKEN = oldToken;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
