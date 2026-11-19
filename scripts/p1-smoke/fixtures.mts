/**
 * @file 提供安装验收所需的离线测试夹具。
 * @implementation 模拟服务与 SDK 响应，生成 PDF 并检查截图像素。
 * @updated 2026-11-20T02:00+08:00
 */
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { inflateSync } from 'node:zlib';
import { array, errorText, record } from './contracts.mjs';

export const model = 'sdk-offline-fixture';
export const prompt = 'Complete the installed acceptance fixture and save its offline receipt.';
export const answer = 'INSTALLED_SDK_LOOPBACK_COMPLETED';
export const receiptName = 'installed-offline-receipt.md';
export const receipt = '# Installed acceptance\nLoopback SDK fixture completed.\n';
const toolUseId = 'toolu_installed_acceptance';

export function samplePdf(): string {
  const stream = '0 0 1 rg 40 40 170 140 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const start = pdf.length;
  return (
    pdf +
    `xref\n0 5\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n${start}\n%%EOF\n`
  );
}

function streamMessage(res: ServerResponse, invokeTool: boolean): void {
  const usage = {
    input_tokens: 12,
    output_tokens: 8,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const events = [
    {
      type: 'message_start',
      message: {
        id: `msg_installed_${invokeTool ? 'tool' : 'answer'}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: invokeTool
        ? { type: 'tool_use', id: toolUseId, name: 'mcp__atelier__publish_artifact', input: {} }
        : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: invokeTool
        ? {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ name: receiptName, content: receipt }),
          }
        : { type: 'text_delta', text: answer },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: invokeTool ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage,
    },
    { type: 'message_stop' },
  ];
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'request-id': `req_installed_${invokeTool ? 'tool' : 'answer'}`,
  });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export interface FixtureEvidence {
  healthMode: 'offline' | 'online';
  gatewayStopped: boolean;
  requests: number;
  toolResultReturned: boolean;
  pdfRequests: number;
  errors: string[];
}

export interface Fixtures {
  evidence: FixtureEvidence;
  gatewayUrl: string;
  siteUrl: string;
  disconnectGateway(): Promise<void>;
  close(): Promise<void>;
}

export async function fixtures(): Promise<Fixtures> {
  const evidence: FixtureEvidence = {
    healthMode: 'offline',
    gatewayStopped: false,
    requests: 0,
    toolResultReturned: false,
    pdfRequests: 0,
    errors: [],
  };
  const gateway = createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (req.method === 'GET' && path === '/health') {
          res.writeHead(evidence.healthMode === 'offline' ? 503 : 200, {
            'Content-Type': 'application/json',
          });
          res.end('{}');
          return;
        }
        assert.equal(req.method, 'POST');
        assert.equal(path, '/v1/messages');
        assert.equal(evidence.healthMode, 'online');
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk as Uint8Array);
          bytes += buffer.length;
          assert.ok(bytes < 2 * 1024 * 1024, 'Fixture request exceeds 2 MiB');
          chunks.push(buffer);
        }
        const request = record(
          JSON.parse(Buffer.concat(chunks).toString()) as unknown,
          'model request',
        );
        assert.equal(request.model, model);
        assert.equal(request.stream, true);
        const messages = array(request.messages, 'messages').map((value) =>
          record(value, 'message'),
        );
        assert.ok(JSON.stringify(messages).includes(prompt), 'Task must reach packaged CLI');
        evidence.requests++;
        assert.ok(evidence.requests <= 2, 'Expected tool call followed by final reply only');
        if (evidence.requests === 1) {
          const tools = array(request.tools, 'SDK tools').map((value) => record(value, 'tool'));
          assert.ok(
            tools.some((tool) => tool.name === 'mcp__atelier__publish_artifact'),
            'Packaged CLI must advertise real controlled tool',
          );
          assert.ok(
            !tools.some((tool) => tool.name === 'mcp__atelier__run_command'),
            'Unavailable command tool must not be advertised',
          );
        } else {
          const blocks = messages
            .flatMap((message) =>
              Array.isArray(message.content) ? (message.content as unknown[]) : [],
            )
            .map((value) => record(value, 'content block'));
          const result = blocks.find(
            (block) => block.type === 'tool_result' && block.tool_use_id === toolUseId,
          );
          assert.ok(
            result && !result.is_error,
            'Real tool result must return through packaged SDK',
          );
          assert.ok(
            JSON.stringify(result).includes(receiptName),
            'Tool result must identify saved receipt',
          );
          evidence.toolResultReturned = true;
        }
        streamMessage(res, evidence.requests === 1);
      } catch (error) {
        evidence.errors.push(errorText(error));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Offline acceptance fixture rejected request',
            },
          }),
        );
      }
    })();
  });
  const site = createServer((req, res) => {
    if (req.url === '/sample.pdf') {
      evidence.pdfRequests++;
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(samplePdf());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><html><head><title>Installed native fixture</title></head><body style="background:#e6f4eb;font:24px sans-serif;padding:32px"><h1>Installed native fixture</h1><label>Fixture input <input autofocus></label></body></html>',
    );
  });
  try {
    return {
      evidence,
      gatewayUrl: await listen(gateway),
      siteUrl: await listen(site),
      async disconnectGateway() {
        await closeServer(gateway);
        evidence.healthMode = 'offline';
        evidence.gatewayStopped = true;
      },
      async close() {
        for (const server of [site, gateway]) await closeServer(server);
      },
    };
  } catch (error) {
    gateway.close();
    site.close();
    throw error;
  }
}

// Count a unique fixture color in the actual Electron canvas screenshot. A loaded
// PDF URL or an empty canvas alone cannot establish that PDF.js painted the page.
export function bluePixels(png: Buffer): { width: number; height: number; blue: number } {
  assert.ok(
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'Expected PNG screenshot',
  );
  let width = 0,
    height = 0,
    channels = 0;
  const parts: Buffer[] = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const size = png.readUInt32BE(offset),
      type = png.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + size + 12 <= png.length, 'Truncated PNG chunk');
    const data = png.subarray(offset + 8, offset + size + 8);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'Expected 8-bit PNG');
      assert.ok(data[9] === 2 || data[9] === 6, 'Expected RGB/RGBA PNG');
      assert.equal(data[12], 0, 'Expected non-interlaced PNG');
      channels = data[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') parts.push(data);
    offset += size + 12;
  }
  assert.ok(
    width > 0 && height > 0 && width * height < 20_000_000 && channels > 0,
    'Invalid screenshot dimensions',
  );
  const stride = width * channels,
    raw = inflateSync(Buffer.concat(parts), { maxOutputLength: (stride + 1) * height });
  assert.equal(raw.length, (stride + 1) * height);
  let prior = Buffer.alloc(stride),
    blue = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)],
      row = Buffer.alloc(stride);
    assert.ok(filter !== undefined && filter <= 4, 'Unknown PNG filter');
    for (let x = 0; x < stride; x++) {
      const left = row[x - channels] ?? 0,
        up = prior[x] ?? 0,
        upperLeft = prior[x - channels] ?? 0;
      const p = left + up - upperLeft;
      const pa = Math.abs(p - left),
        pb = Math.abs(p - up),
        pc = Math.abs(p - upperLeft);
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : pa <= pb && pa <= pc
                  ? left
                  : pb <= pc
                    ? up
                    : upperLeft;
      row[x] = ((raw[y * (stride + 1) + 1 + x] ?? 0) + predictor) & 255;
    }
    for (let x = 0; x < stride; x += channels)
      if ((row[x] ?? 255) < 20 && (row[x + 1] ?? 255) < 20 && (row[x + 2] ?? 0) > 230) blue++;
    prior = row;
  }
  return { width, height, blue };
}
