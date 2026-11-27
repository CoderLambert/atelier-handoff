/**
 * @file 接收锁定 SDK 的本机请求跨度。
 * @implementation 为每轮提供认证回环端点，只保留有界的计时与关联信息，SDK 退出后释放监听。
 * @updated 2026-11-27T02:58:23+08:00
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { modelRequestTimingSchema, requestTimingLimit } from '../shared/request-timing.js';
import type { ObservedModelRequest } from './request-timing.js';

const spanSchema = z.object({
  name: z.literal('claude_code.llm_request'),
  spanId: z.string().regex(/^[0-9a-f]{16}$/iu),
  traceId: z.string().regex(/^[0-9a-f]{32}$/iu),
  startTimeUnixNano: z.string().regex(/^\d{1,20}$/u),
  endTimeUnixNano: z.string().regex(/^\d{1,20}$/u),
  attributes: z.array(z.object({ key: z.string(), value: z.unknown() })).optional(),
  status: z.object({ code: z.number().optional() }).optional(),
});
const traceBatchSchema = z.object({
  resourceSpans: z.array(
    z.object({
      scopeSpans: z.array(z.object({ spans: z.array(z.unknown()) })),
    }),
  ),
});
const attributeValue = z.object({
  stringValue: z.string().max(256).optional(),
  intValue: z.union([z.number(), z.string().regex(/^\d{1,16}$/u)]).optional(),
  boolValue: z.boolean().optional(),
  doubleValue: z.number().optional(),
});
const maxBodyBytes = 1024 * 1024;
const tracesPath = '/v1/traces';
const tokenHeader = 'x-atelier-trace-token';

function observedRequest(value: unknown) {
  const parsed = spanSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const span = parsed.data;
  const start = BigInt(span.startTimeUnixNano);
  const length = BigInt(span.endTimeUnixNano) - start;
  if (length < 0n) return undefined;
  const attributes = new Map((span.attributes ?? []).map(({ key, value }) => [key, value]));
  const attr = (key: string) => attributeValue.safeParse(attributes.get(key)).data;
  const integer = (key: string) => {
    const raw = attr(key);
    const value = Number(raw?.intValue ?? raw?.doubleValue);
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const success = attr('success')?.boolValue;
  const statusCode = integer('status_code') ?? integer('http.response.status_code');
  const timing = modelRequestTimingSchema.safeParse({
    startedAt: Number(start / 1_000_000n),
    durationMs: Math.round(Number(length) / 1_000_000),
    ttftMs: integer('ttft_ms'),
    firstContentMs: integer('first_content_ms'),
    attempts: integer('attempt') || undefined,
    statusCode:
      statusCode !== undefined && statusCode >= 100 && statusCode <= 599 ? statusCode : undefined,
    failed: success === undefined ? span.status?.code === 2 || undefined : !success,
  });
  if (!timing.success) return undefined;
  return {
    key: `${span.traceId}:${span.spanId}`,
    request: { requestId: attr('request_id')?.stringValue, timing: timing.data },
  };
}

function collectorEnvironment(endpoint: string, token: string): NodeJS.ProcessEnv {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    ENABLE_BETA_TRACING_DETAILED: '0',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_ENDPOINT: new URL(endpoint).origin,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: `${tokenHeader}=${token}`,
    OTEL_EXPORTER_OTLP_TRACES_COMPRESSION: 'none',
    OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '1000',
    OTEL_TRACES_EXPORT_INTERVAL: '500',
    OTEL_BSP_SCHEDULE_DELAY: '500',
    OTEL_LOG_USER_PROMPTS: '0',
    OTEL_LOG_ASSISTANT_RESPONSES: '0',
    OTEL_LOG_TOOL_DETAILS: '0',
    OTEL_LOG_TOOL_CONTENT: '0',
    OTEL_LOG_RAW_API_BODIES: '0',
  };
}

export async function openSdkRequestTraces() {
  const token = randomBytes(32).toString('hex');
  const requests = new Map<string, ObservedModelRequest>();
  let omitted = 0;
  const server = createServer({
    maxHeaderSize: 8192,
    requestTimeout: 2000,
    headersTimeout: 2000,
    keepAliveTimeout: 500,
    connectionsCheckingInterval: 1000,
  });
  server.maxConnections = 8;
  server.setTimeout(2000, (socket) => socket.destroy());

  async function collect(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST' || req.url !== tracesPath || req.headers[tokenHeader] !== token) {
      res.writeHead(404, { connection: 'close' }).end();
      return;
    }
    if (req.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
      res.writeHead(415, { connection: 'close' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBodyBytes) {
        res.writeHead(413, { connection: 'close' }).end();
        return;
      }
      chunks.push(buffer);
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    const batch = traceBatchSchema.safeParse(raw);
    if (!batch.success) {
      res.writeHead(400).end();
      return;
    }
    for (const resource of batch.data.resourceSpans)
      for (const scope of resource.scopeSpans)
        for (const span of scope.spans) {
          const observation = observedRequest(span);
          if (!observation || requests.has(observation.key)) continue;
          if (requests.size < requestTimingLimit)
            requests.set(observation.key, observation.request);
          else omitted++;
        }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  }
  server.on('request', (req, res) => {
    void collect(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) res.writeHead(400, { connection: 'close' }).end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('SDK trace receiver has no loopback address');
  }
  return {
    env: collectorEnvironment(`http://127.0.0.1:${address.port}${tracesPath}`, token),
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return { requests: [...requests.values()], omitted };
    },
  };
}
