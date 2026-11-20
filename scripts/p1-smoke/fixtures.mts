/**
 * @file 提供安装验收所需的离线测试夹具。
 * @implementation 提供回环模型、需审批的 MCP 和网页夹具，验证导航超时后继续读取页面及自动化长任务交付，并提供 PDF 和截图检查数据。
 * @updated 2026-11-20T22:16:28+08:00
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { inflateSync } from 'node:zlib';
import {
  array,
  browserSnapshot,
  errorText,
  record,
  string,
  type AutomaticFixtureEvidence,
  type BrowserFixtureEvidence,
} from './contracts.mjs';

export const model = 'sdk-offline-fixture';
export const alternateModel = 'sdk-offline-alternate';
export const prompt = 'Complete the installed acceptance fixture and save its offline receipt.';
export const answer = 'INSTALLED_SDK_LOOPBACK_COMPLETED';
export const receiptName = 'installed-offline-receipt.md';
export const receipt = '# Installed acceptance\nLoopback SDK fixture completed.\n';
const toolUseId = 'toolu_installed_acceptance';
export const queuePrompts = [
  'Queue fixture first turn.',
  'Queue fixture second turn.',
  'Queue fixture third turn.',
] as const;
export const queueAnswers = [
  'INSTALLED_QUEUE_FIRST',
  'INSTALLED_QUEUE_SECOND',
  'INSTALLED_QUEUE_THIRD',
] as const;
export const queueWithdrawn = 'Queue fixture withdrawn turn.';
export const liveInitial = 'Hold this actively streaming reply for immediate insertion.';
export const liveInserted = 'Read this inserted steering message immediately.';
export const liveAnswer = 'INSTALLED_LIVE_INPUT_COMPLETED';
export const documentPrompt =
  'Inspect the selected large workbook Target sheet and return its last record.';
export const documentAnswer = 'INSTALLED_ATTACHMENT_READ_COMPLETED';
const documentReadId = 'toolu_installed_document_read';

export const browserReadPrompt = 'Observe the installed native browser fixture in read-only mode.';
export const browserEditPrompt =
  'Observe the browser again after handoff, approve one click, and save its PNG.';
export const browserReadAnswer = 'INSTALLED_NATIVE_BROWSER_OBSERVED';
export const browserEditAnswer = 'INSTALLED_NATIVE_BROWSER_COMPLETED';
export const browserTitle = 'Installed Agent browser fixture';
export const browserClickLabel = 'Apply native browser fixture';
export const browserManualValue = 'installed-browser-manual-handoff';
export const automaticPrompt =
  'Complete the isolated automatic fixture: click the native page, write its local receipt, and call the local approval MCP.';
export const automaticAnswer = 'INSTALLED_AUTOMATIC_TOOLS_COMPLETED';
export const automaticFollowupPrompt = 'Verify the saved automatic session mode on this follow-up.';
export const automaticFollowupAnswer = 'INSTALLED_SESSION_AUTOMATION_PERSISTED';
export const chatLinkLabel = '查看本地测试网页';
export const chatLinkPath = '/browser-chat-link';
export const browserDownloadLabel = '附件4.苏州市2026年市属事业单位公开招聘咨询电话一览表';
export const browserDownloadName = `${browserDownloadLabel}.xls`;
const browserDownloadPath = '/downloads/346049a64aa44dcda7e6e2ebd9cb7cad.xls';
// BIFF2 workbook with a representative result row.
export const browserDownloadBody = Buffer.from(
  'CQAEAAIAEAAeAAgAB0dlbmVyYWxDAAQAAAAAAAQAEgAAAAAAAAAACkRlcGFydG1lbnQEABIAAAABAAAAAApBcHBsaWNhbnRzBAATAAEAAAAAAAALU3V6aG91IGpvYnMCAAkAAQABAAAAACoACgAAAA==',
  'base64',
);
export const automaticToolCount = 17;
export const automaticReceiptName = 'installed-automatic-receipt.txt';
export const automaticReceipt = 'Installed automatic browser, file, and MCP fixture completed.\n';
export const automaticMcpName = 'installed-auto-fixture';
export const automaticMcpTool = 'fixture_approval';
const automaticMcpResult = 'INSTALLED_AUTOMATIC_MCP_EFFECT';
const automaticToolIds = {
  navigate: 'toolu_installed_auto_navigate',
  snapshot: 'toolu_installed_auto_snapshot',
  click: 'toolu_installed_auto_click',
  confirmation: 'toolu_installed_auto_confirmation',
  write: 'toolu_installed_auto_write',
  mcp: 'toolu_installed_auto_mcp',
} as const;
const browserToolIds = {
  navigate: 'toolu_installed_browser_navigate',
  stalledNavigation: 'toolu_installed_browser_stalled_navigation',
  initialSnapshot: 'toolu_installed_browser_initial_snapshot',
  refreshedSnapshot: 'toolu_installed_browser_refreshed_snapshot',
  click: 'toolu_installed_browser_click',
  confirmation: 'toolu_installed_browser_confirmation',
  screenshot: 'toolu_installed_browser_screenshot',
} as const;

function toolResultText(messages: Record<string, unknown>[], id: string): string {
  const result = messages
    .flatMap((message) => (Array.isArray(message.content) ? (message.content as unknown[]) : []))
    .map((value) => record(value, 'content block'))
    .find((block) => block.type === 'tool_result' && block.tool_use_id === id);
  assert.ok(result && !result.is_error, `Real SDK must return successful tool result ${id}`);
  if (typeof result.content === 'string') return result.content;
  return array(result.content, 'tool result content')
    .map((value) => {
      const block = record(value, 'tool result block');
      assert.equal(
        block.type,
        'text',
        'Native browser results must be text, without inline images',
      );
      return string(block.text);
    })
    .join('\n');
}

function snapshotButton(messages: Record<string, unknown>[], id: string, url: string) {
  const snapshot = browserSnapshot(JSON.parse(toolResultText(messages, id)) as unknown);
  assert.equal(snapshot.url, url);
  assert.equal(snapshot.title, browserTitle);
  const button = snapshot.elements.find(
    (element) => element.role === 'button' && element.name === browserClickLabel,
  );
  assert.ok(button?.ref, 'Browser snapshot must contain a real clickable ref');
  return { snapshot, ref: button.ref };
}

function browserMessage(
  res: ServerResponse,
  request: Record<string, unknown>,
  messages: Record<string, unknown>[],
  evidence: BrowserFixtureEvidence,
  siteUrl: string,
  edit: boolean,
): void {
  const tools = array(request.tools, 'SDK tools').map((value) => string(record(value).name));
  for (const name of ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot'])
    assert.ok(
      tools.includes(`mcp__atelier__${name}`),
      `Native read tool ${name} must be advertised`,
    );
  for (const name of ['browser_click', 'browser_type'])
    assert.equal(tools.includes(`mcp__atelier__${name}`), edit, `${name} is edit mode only`);
  const url = `${siteUrl}/browser`;
  const step = edit ? ++evidence.editRequests : ++evidence.readRequests;
  assert.ok(step <= (edit ? 5 : 4), 'Unexpected native browser model request');
  const invoke = (id: string, name: string, input: Record<string, unknown>) => {
    const fullName = `mcp__atelier__${name}`;
    evidence.calls.push({ name: fullName, input });
    streamMessage(res, { id, name: fullName, input });
  };
  if (!edit) {
    if (step === 1) return invoke(browserToolIds.navigate, 'browser_navigate', { url });
    if (step === 2) {
      assert.ok(toolResultText(messages, browserToolIds.navigate).includes(url));
      return invoke(browserToolIds.stalledNavigation, 'browser_navigate', {
        url: `${siteUrl}/browser-stalled`,
      });
    }
    if (step === 3) {
      const failure = messages
        .flatMap((message) =>
          Array.isArray(message.content) ? (message.content as unknown[]) : [],
        )
        .map((value) => record(value, 'content block'))
        .find((block) => block.tool_use_id === browserToolIds.stalledNavigation);
      assert.equal(failure?.is_error, true, 'The SDK must receive a real browser tool failure');
      assert.match(JSON.stringify(failure), /60 秒内未完成。原标签已保留。/u);
      return invoke(browserToolIds.initialSnapshot, 'browser_snapshot', {});
    }
    evidence.initialRef = snapshotButton(messages, browserToolIds.initialSnapshot, url).ref;
    streamMessage(res, undefined, browserReadAnswer);
    return;
  }
  if (step === 1) return invoke(browserToolIds.refreshedSnapshot, 'browser_snapshot', {});
  if (step === 2) {
    const { snapshot, ref } = snapshotButton(messages, browserToolIds.refreshedSnapshot, url);
    assert.ok(
      JSON.stringify(snapshot).includes(browserManualValue),
      'New observation must include the human handoff change',
    );
    assert.notEqual(ref, evidence.initialRef, 'Handoff must invalidate the original element refs');
    evidence.refreshedRef = ref;
    return invoke(browserToolIds.click, 'browser_click', { ref });
  }
  if (step === 3) {
    assert.ok(toolResultText(messages, browserToolIds.click).length > 0);
    evidence.clickResultReturned = true;
    return invoke(browserToolIds.confirmation, 'browser_snapshot', {});
  }
  if (step === 4) {
    const { snapshot } = snapshotButton(messages, browserToolIds.confirmation, url);
    assert.ok(JSON.stringify(snapshot).includes('Browser action completed'));
    return invoke(browserToolIds.screenshot, 'browser_take_screenshot', {});
  }
  const result = toolResultText(messages, browserToolIds.screenshot);
  const id = /\b[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\b/i.exec(result)?.[0];
  assert.ok(id, 'Screenshot tool result must identify its saved PNG artifact');
  evidence.screenshotArtifactId = id;
  streamMessage(res, undefined, browserEditAnswer);
}

function automaticMessage(
  res: ServerResponse,
  request: Record<string, unknown>,
  messages: Record<string, unknown>[],
  evidence: AutomaticFixtureEvidence,
  siteUrl: string,
): void {
  const tools = array(request.tools, 'automatic SDK tools').map((value) => record(value));
  const external = tools.filter(
    (tool) =>
      string(tool.name).startsWith('mcp__atelier__external_') &&
      string(tool.description).includes(`${automaticMcpName}/${automaticMcpTool}`),
  );
  assert.equal(external.length, 1, 'The granted local approval MCP must reach the SDK');
  for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click', 'write_file'])
    assert.ok(tools.some((tool) => tool.name === `mcp__atelier__${name}`));
  const url = `${siteUrl}/browser-automatic`;
  const step = ++evidence.requests;
  assert.ok(step <= automaticToolCount + 1, 'Expected a long task followed by one final reply');
  const invoke = (id: string, name: string, input: Record<string, unknown>) => {
    evidence.calls.push({ name, input });
    streamMessage(res, { id, name, input });
  };
  if (step === 1)
    return invoke(automaticToolIds.navigate, 'mcp__atelier__browser_navigate', { url });
  if (step === 2) {
    assert.ok(toolResultText(messages, automaticToolIds.navigate).includes(url));
    return invoke(automaticToolIds.snapshot, 'mcp__atelier__browser_snapshot', {});
  }
  if (step === 3) {
    const { ref } = snapshotButton(messages, automaticToolIds.snapshot, url);
    return invoke(automaticToolIds.click, 'mcp__atelier__browser_click', { ref });
  }
  if (step === 4) {
    assert.ok(toolResultText(messages, automaticToolIds.click).length > 0);
    evidence.clickResultReturned = true;
    return invoke(automaticToolIds.confirmation, 'mcp__atelier__browser_snapshot', {});
  }
  if (step === 5) {
    const { snapshot } = snapshotButton(messages, automaticToolIds.confirmation, url);
    assert.ok(JSON.stringify(snapshot).includes('Browser action completed'));
    return invoke(automaticToolIds.write, 'mcp__atelier__write_file', {
      path: automaticReceiptName,
      content: automaticReceipt,
      reason: 'Isolated installed automatic smoke receipt',
    });
  }
  if (step === 6) {
    const written = record(JSON.parse(toolResultText(messages, automaticToolIds.write)) as unknown);
    assert.equal(written.path, automaticReceiptName);
    assert.equal(written.applied, true);
    evidence.writeResultReturned = true;
    return invoke(automaticToolIds.mcp, string(external[0]?.name), { arguments: {} });
  }
  if (step === 7) {
    assert.ok(toolResultText(messages, automaticToolIds.mcp).includes(automaticMcpResult));
    assert.equal(evidence.mcpCalls, 1, 'Exactly one call must execute on the local MCP server');
    evidence.mcpResultReturned = true;
  } else {
    const { snapshot } = snapshotButton(messages, `toolu_installed_long_${step - 1}`, url);
    assert.ok(JSON.stringify(snapshot).includes('Browser action completed'));
  }
  if (step <= automaticToolCount)
    return invoke(`toolu_installed_long_${step}`, 'mcp__atelier__browser_snapshot', {});
  streamMessage(res, undefined, automaticAnswer);
}

async function approvalMcp(
  req: IncomingMessage,
  res: ServerResponse,
  evidence: FixtureEvidence,
): Promise<void> {
  const server = new McpServer({ name: automaticMcpName, version: '1.0.0' });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  server.registerTool(
    automaticMcpTool,
    { description: 'Record an isolated installed smoke invocation; project approval is required.' },
    async () => {
      evidence.automatic.mcpCalls++;
      return { content: [{ type: 'text', text: automaticMcpResult }] };
    },
  );
  res.once('close', () => {
    void server.close().catch((error: unknown) => evidence.errors.push(errorText(error)));
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    evidence.errors.push(errorText(error));
    if (!res.headersSent) res.writeHead(500);
    res.end();
    await server.close();
  }
}

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

let messageSequence = 0;

function streamMessage(
  res: ServerResponse,
  tool?: { id: string; name: string; input: Record<string, unknown> },
  text = answer,
  responseModel = model,
  hold = false,
): void {
  const invokeTool = tool !== undefined;
  const sequence = ++messageSequence;
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
        id: `msg_installed_${sequence}`,
        type: 'message',
        role: 'assistant',
        model: responseModel,
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
        ? { type: 'tool_use', id: tool.id, name: tool.name, input: {} }
        : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: invokeTool
        ? {
            type: 'input_json_delta',
            partial_json: JSON.stringify(tool.input),
          }
        : { type: 'text_delta', text },
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
    'request-id': `req_installed_${sequence}`,
  });
  for (const event of hold ? events.slice(0, 3) : events)
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  if (!hold) res.end();
}

export function streamFixtureApproval(res: ServerResponse): void {
  streamMessage(res, {
    id: toolUseId,
    name: 'mcp__atelier__write_file',
    input: {
      path: 'approval-fixture.txt',
      content: 'pending write',
      reason: 'desktop recovery test',
    },
  });
}

export async function listen(server: Server): Promise<string> {
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
  browserDownloadRequests: number;
  queueRequests: string[];
  liveRequests: string[];
  documentRequests: number;
  nativeBrowser: BrowserFixtureEvidence;
  automatic: AutomaticFixtureEvidence;
  errors: string[];
}

export interface Fixtures {
  evidence: FixtureEvidence;
  gatewayUrl: string;
  siteUrl: string;
  releaseQueueFirst(): void;
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
    browserDownloadRequests: 0,
    queueRequests: [],
    liveRequests: [],
    documentRequests: 0,
    nativeBrowser: {
      readRequests: 0,
      editRequests: 0,
      calls: [],
      initialRef: null,
      refreshedRef: null,
      clickResultReturned: false,
      screenshotArtifactId: null,
    },
    automatic: {
      requests: 0,
      calls: [],
      clickResultReturned: false,
      writeResultReturned: false,
      mcpResultReturned: false,
      mcpCalls: 0,
    },
    errors: [],
  };
  let queueFirst: ServerResponse | undefined;
  let siteUrl: string;
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
        if (req.method === 'GET' && path === '/routes') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: [{ model: alternateModel, provider: 'fixture' }],
            }),
          );
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
        assert.equal(request.stream, true);
        const messages = array(request.messages, 'messages').map((value) =>
          record(value, 'message'),
        );
        const conversation = JSON.stringify(messages);
        const latestUser = JSON.stringify(messages.findLast((item) => item.role === 'user') ?? {});
        const currentTask = latestUser.split('用户本轮任务：').at(-1) ?? '';
        if (currentTask.includes(liveInserted)) {
          evidence.liveRequests.push(liveInserted);
          assert.deepEqual(evidence.liveRequests, [liveInitial, liveInserted]);
          streamMessage(res, undefined, liveAnswer);
          return;
        }
        if (currentTask.includes(liveInitial)) {
          evidence.liveRequests.push(liveInitial);
          streamMessage(res, undefined, 'Partial reply before insertion.', model, true);
          return;
        }
        if (currentTask.includes(documentPrompt) || latestUser.includes(documentReadId)) {
          if (++evidence.documentRequests === 1) {
            const path = /\/[^"\\\s]*\/sheet-0002\.txt/u.exec(latestUser)?.[0];
            assert.ok(path, 'SDK receives a local file reference for the target sheet');
            streamMessage(res, {
              id: documentReadId,
              name: 'Read',
              input: { file_path: path, limit: 16 },
            });
          } else {
            assert.equal(evidence.documentRequests, 2);
            assert.match(toolResultText(messages, documentReadId), /last-hiring-record/u);
            streamMessage(res, undefined, documentAnswer);
          }
          return;
        }
        assert.ok(!currentTask.includes(queueWithdrawn), 'Withdrawn input must not reach SDK');
        const queueStage = queuePrompts.findIndex((text) => currentTask.includes(text));
        const queueAnswer = queueAnswers[queueStage];
        const queuePrompt = queuePrompts[queueStage];
        if (queueAnswer && queuePrompt) {
          assert.equal(
            evidence.queueRequests.length,
            queueStage,
            'Queue requests must arrive in FIFO order',
          );
          if (queueStage > 0)
            assert.ok(
              conversation.includes(queueAnswers[queueStage - 1] ?? ''),
              'Queued turn must have prior answer',
            );
          assert.ok(
            queuePrompts.slice(queueStage + 1).every((prompt) => !conversation.includes(prompt)),
            'Future messages stay out of current model history',
          );
          evidence.queueRequests.push(queuePrompt);
          if (queueStage === 0) queueFirst = res;
          else streamMessage(res, undefined, queueAnswer);
          return;
        }
        if (conversation.includes(automaticFollowupPrompt)) {
          assert.equal(
            request.model,
            alternateModel,
            'The next SDK request uses the selected model',
          );
          assert.equal(record(request.output_config).effort, 'xhigh');
          assert.equal(++evidence.automatic.requests, automaticToolCount + 2);
          streamMessage(
            res,
            undefined,
            `${automaticFollowupAnswer}\n\n[${chatLinkLabel}](${siteUrl}${chatLinkPath})`,
            alternateModel,
          );
          return;
        }
        assert.equal(request.model, model);
        if (conversation.includes(automaticPrompt)) {
          automaticMessage(res, request, messages, evidence.automatic, siteUrl);
          return;
        }
        if (conversation.includes(browserReadPrompt) || conversation.includes(browserEditPrompt)) {
          browserMessage(
            res,
            request,
            messages,
            evidence.nativeBrowser,
            siteUrl,
            conversation.includes(browserEditPrompt),
          );
          return;
        }
        assert.ok(conversation.includes(prompt), 'Task must reach packaged CLI');
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
          assert.ok(
            !tools.some((tool) => String(tool.name).startsWith('mcp__atelier__browser_')),
            'A fresh project must not expose native browser tools before project authorization',
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
        streamMessage(
          res,
          evidence.requests === 1
            ? {
                id: toolUseId,
                name: 'mcp__atelier__publish_artifact',
                input: { name: receiptName, content: receipt },
              }
            : undefined,
        );
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
    // Leave the response pending so Chromium times out before committing a new page.
    if (req.url === '/browser-stalled') return;
    if (req.url === '/mcp') {
      void approvalMcp(req, res, evidence).catch((error: unknown) =>
        evidence.errors.push(errorText(error)),
      );
      return;
    }
    if (req.url === '/sample.pdf') {
      evidence.pdfRequests++;
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(samplePdf());
      return;
    }
    if (req.url === browserDownloadPath) {
      evidence.browserDownloadRequests++;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.ms-excel',
        'Content-Length': Buffer.byteLength(browserDownloadBody),
      });
      const midpoint = browserDownloadBody.length >> 1;
      res.write(browserDownloadBody.subarray(0, midpoint));
      const timer = setTimeout(() => res.end(browserDownloadBody.subarray(midpoint)), 1800);
      res.once('close', () => clearTimeout(timer));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url === '/browser' || req.url === '/browser-automatic') {
      res.end(`<!doctype html><html><head><title>${browserTitle}</title></head>
<body data-agent-clicks="0" style="background:#e6f4eb;font:20px sans-serif;padding:24px">
<h1>${browserTitle}</h1>
<label>Browser handoff input <input oninput="document.getElementById('handoff').textContent='Human input: '+this.value"></label>
<p id="handoff">Awaiting human handoff</p>
<button onclick="document.body.dataset.agentClicks=String(Number(document.body.dataset.agentClicks)+1);document.getElementById('result').textContent='Browser action completed';document.getElementById('paint').style.background='#0000ff'">${browserClickLabel}</button>
<p id="result">Browser action pending</p><div id="paint" style="width:170px;height:140px"></div>
</body></html>`);
      return;
    }
    res.end(
      `<!doctype html><html><head><title>Installed native fixture</title></head><body style="background:#e6f4eb;font:24px sans-serif;padding:32px"><h1>Installed native fixture</h1><label>Fixture input <input autofocus></label><p><a href="${browserDownloadPath}" target="_blank">${browserDownloadLabel}</a></p></body></html>`,
    );
  });
  try {
    siteUrl = await listen(site);
    return {
      evidence,
      gatewayUrl: await listen(gateway),
      siteUrl,
      releaseQueueFirst() {
        assert.ok(
          queueFirst && !queueFirst.writableEnded,
          'Initial queue request is still pending',
        );
        streamMessage(queueFirst, undefined, queueAnswers[0]);
      },
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
