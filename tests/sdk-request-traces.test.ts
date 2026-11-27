/**
 * @file 验证请求跨度接收器的认证边界和脱敏投影。
 * @implementation 向临时回环接收器发送 OTLP JSON，检查无效请求、重复跨度和正文均不会污染采样。
 * @updated 2026-11-27T03:10:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { openSdkRequestTraces } from '../server/sdk-request-traces.js';

test('SDK trace receiver authenticates bounded loopback requests and projects timing only', async () => {
  const receiver = await openSdkRequestTraces();
  const endpoint = receiver.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const header = receiver.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
  assert.ok(endpoint && header);
  assert.equal(new URL(endpoint).hostname, '127.0.0.1');
  const [name, token] = header.split('=');
  assert.ok(name && token);
  const secret = 'SYNTHETIC_CONTENT_NOT_FOR_DIAGNOSTICS';
  const span = {
    name: 'claude_code.llm_request',
    traceId: '1'.repeat(32),
    spanId: '1'.repeat(16),
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000000123000000',
    attributes: [
      { key: 'user_prompt', value: { stringValue: secret } },
      { key: 'request_id', value: { stringValue: 'req_fixture_unique' } },
      { key: 'ttft_ms', value: { intValue: '42' } },
      { key: 'first_content_ms', value: { intValue: '55' } },
      { key: 'attempt', value: { intValue: '2' } },
      { key: 'status_code', value: { intValue: '200' } },
    ],
  };
  const body = JSON.stringify({
    resourceSpans: [{ scopeSpans: [{ spans: [span, span, { ...span, name: 'other' }] }] }],
  });
  const send = async (input: string, auth?: string) => {
    const contract = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth && { [name]: auth }) },
      body: input,
    });
    await contract.arrayBuffer();
    return contract.status;
  };
  try {
    assert.equal(await send(body, 'wrong'), 404);
    assert.equal(await send('invalid', token), 400);
    assert.equal(await send(' '.repeat(1024 * 1024 + 1), token), 413);
    assert.equal(await send(body, token), 200);
  } finally {
    const observed = await receiver.close();
    assert.deepEqual(observed, {
      requests: [
        {
          requestId: 'req_fixture_unique',
          timing: {
            startedAt: 1_700_000_000_000,
            durationMs: 123,
            ttftMs: 42,
            firstContentMs: 55,
            attempts: 2,
            statusCode: 200,
            failed: undefined,
          },
        },
      ],
      omitted: 0,
    });
    assert.doesNotMatch(JSON.stringify(observed), /SYNTHETIC_CONTENT_NOT_FOR_DIAGNOSTICS/);
  }
  await assert.rejects(fetch(endpoint));
});
