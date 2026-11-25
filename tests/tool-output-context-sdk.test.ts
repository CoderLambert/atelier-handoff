/**
 * @file 验证真实 Agent SDK 的长工具输出摘要、持久记录与分页读取契约。
 * @implementation 用隔离 HOME、项目和数据根及回环模型驱动真实 Bash 与工作台命令，核对请求摘要、持久原文、UTF-16 分页、短回执和失败状态。
 * @updated 2026-11-22T19:34:06+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { z } from 'zod';
import { AgentRunner } from '../server/agent.js';
import { FileRecords } from '../server/artifacts.js';
import { commandsAvailable } from '../server/commands.js';
import { PermissionService } from '../server/permissions.js';
import { Store } from '../server/store.js';
import { emptyDraft, now, type Run } from '../shared/types.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

const model = 'fixture-tool-output-context';
const pageTool = 'mcp__atelier__read_tool_output';
const threshold = 6000;
const requestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  tools: z.array(z.object({ name: z.string() })),
});
const resultSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))]),
  is_error: z.boolean().optional(),
});
const receiptSchema = z.object({ stdout: z.string(), stderr: z.string() }).passthrough();
const pageSchema = z.object({
  toolCallId: z.string(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  excerpt: z.string(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
type ModelRequest = z.infer<typeof requestSchema>;
type Fixture = {
  root: string;
  projectPath: string;
  store: Store;
  files: FileRecords;
  run: Run;
};

function toolResult(request: ModelRequest, toolUseId: string) {
  const results = request.messages.flatMap(({ role, content }) =>
    role === 'user' && Array.isArray(content)
      ? content.flatMap((block: unknown) => {
          const result = resultSchema.safeParse(block);
          return result.success && result.data.tool_use_id === toolUseId ? [result.data] : [];
        })
      : [],
  );
  assert.equal(results.length, 1, `expected exactly one result for ${toolUseId}`);
  const result = results[0];
  assert.ok(result);
  return {
    text:
      typeof result.content === 'string'
        ? result.content
        : result.content.map(({ text }) => text).join('\n'),
    isError: result.is_error === true,
  };
}

async function persistedToolOutput(store: Store, id: string): Promise<string> {
  const reopened = new Store(store.directory);
  try {
    return await new FileRecords(reopened).toolOutput(id);
  } finally {
    reopened.close();
  }
}

async function withSdkFixture(
  context: TestContext,
  handle: (request: ModelRequest, response: ServerResponse, fixture: Fixture) => Promise<void>,
  setup: (fixture: Fixture) => Promise<void>,
  execution: Pick<Run, 'executor' | 'approvalMode'> = { executor: 'native-v1' },
) {
  // Pin the installed SDK actually used by AgentRunner, independently of the declared dependency.
  const sdkPackage = join(
    dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))),
    'package.json',
  );
  const sdkVersion = z
    .object({ version: z.literal('0.3.332') })
    .parse(JSON.parse(await readFile(sdkPackage, 'utf8')));
  context.diagnostic(
    `real Agent SDK ${sdkVersion.version}; synthetic loopback gateway; no paid model`,
  );
  const root = await mkdtemp(join(tmpdir(), 'atelier-tool-output-sdk-'));
  const projectPath = join(root, 'project');
  const isolatedEnvironment = {
    HOME: join(root, 'home'),
    SHELL: '/bin/sh',
    XDG_CONFIG_HOME: join(root, 'home', '.config'),
    XDG_DATA_HOME: join(root, 'home', '.local', 'share'),
    XDG_CACHE_HOME: join(root, 'home', '.cache'),
    TMPDIR: join(root, 'tmp'),
    ATELIER_DISABLE_SUBAGENTS: '1',
  };
  const previousEnvironment = new Map(
    Object.keys(isolatedEnvironment).map((key) => [key, process.env[key]]),
  );
  await Promise.all(
    [projectPath, isolatedEnvironment.HOME, isolatedEnvironment.TMPDIR].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  // os.homedir() and native skill mounting also resolve this synthetic HOME. node:test
  // runs this file in its own process; sibling test files keep their original environment.
  Object.assign(process.env, isolatedEnvironment);
  const failures: unknown[] = [];
  const store = new Store(join(root, 'data'));
  const files = new FileRecords(store);
  const runner = new AgentRunner(store, new PermissionService(store), files);
  const project = store.put('projects', {
    id: randomUUID(),
    name: 'Synthetic tool output fixture',
    path: projectPath,
    branch: '',
    available: true,
    createdAt: now(),
  });
  const session = store.put('sessions', {
    id: randomUUID(),
    projectId: project.id,
    title: 'Synthetic tool output fixture',
    status: 'active',
    sdkSessionId: null,
    draft: emptyDraft(),
    createdAt: now(),
    updatedAt: now(),
  });
  let fixture: Fixture;
  const gateway = createServer(async (request, response) => {
    try {
      assert.equal(new URL(request.url ?? '/', 'http://127.0.0.1').pathname, '/v1/messages');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const parsed = requestSchema.parse(decoded);
      assert.equal(parsed.model, model);
      await handle(parsed, response, fixture);
    } catch (error) {
      failures.push(error);
      // Complete the local SDK turn so assertion failures do not become retry/time-out noise.
      sendModelReply(response, model, 'SYNTHETIC_GATEWAY_ASSERTION_FAILED');
    }
  });
  try {
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const address = gateway.address();
    assert.ok(address && typeof address === 'object');
    const run: Run = store.put('runs', {
      id: randomUUID(),
      projectId: project.id,
      sessionId: session.id,
      prompt: 'Run the synthetic tool-output fixture.',
      ...execution,
      mode: 'edit',
      status: 'queued',
      createdAt: now(),
      startedAt: null,
      endedAt: null,
      reason: null,
      error: null,
      retryOf: null,
      contextPaths: [],
      attachmentIds: [],
      plan: [],
      usage: null,
      config: {
        gateway: `http://127.0.0.1:${address.port}`,
        model,
        limitExecution: true,
        maxTurns: 16,
        timeoutMs: 30_000,
      },
    });
    fixture = { root, projectPath, store, files, run };
    await setup(fixture);
    await runner.start(run, run.prompt);
    assert.deepEqual(failures, []);
    const finished = store.get('runs', run.id);
    assert.equal(finished.status, 'completed', finished.error ?? undefined);
    if (run.executor === 'native-v1') assert.equal(store.list('permissions').length, 0);
  } finally {
    await runner.shutdown();
    store.close();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test(
  'real SDK summarizes long Bash output before the next model request and reads its persisted JSON receipt in UTF-16 pages',
  { skip: process.platform !== 'linux', timeout: 40_000 },
  async (context) => {
    const secret = `SYNTHETIC_MIDDLE_${randomUUID()}`;
    // JSON escaping crosses the file preview limit while stdout stays below the
    // native SDK's roughly 30 KB byte cap. The astral character distinguishes UTF-16 offsets.
    const output =
      'synthetic-start字𠮷\n' +
      '\\"\n'.repeat(2700) +
      secret +
      '\n' +
      '\\"\n'.repeat(2700) +
      'z'.repeat(1000);
    const bashId = 'toolu_long_bash';
    const shortId = 'toolu_short_bash';
    const shortOutput = 'short synthetic response';
    const limit = 8000; // An explicitly requested page may exceed the automatic summary threshold.
    let requestCount = 0;
    let saved = '';
    let recordId = '';
    let nextOffset = 0;
    let pageCount = 0;
    let reconstructed = '';
    let markerRead = false;
    let summary = '';
    let prematureMarker = false;
    let persistedOnDisk = false;
    await withSdkFixture(
      context,
      async (request, response, { root, store, files, run }) => {
        ++requestCount;
        assert.ok(
          request.tools.some(({ name }) => name === pageTool),
          'page tool must be registered with the real SDK',
        );
        if (requestCount === 1) {
          sendModelReply(response, model, [
            {
              name: 'Bash',
              id: bashId,
              input: {
                command: 'cat synthetic-output.txt',
                description: 'Read synthetic fixture output',
              },
            },
          ]);
          return;
        }
        if (requestCount === 2) {
          const result = toolResult(request, bashId);
          const record = store.list('tools').find(({ name }) => name === 'Bash');
          assert.ok(record);
          recordId = record.id;
          saved = await files.toolOutput(recordId);
          const receipt = receiptSchema.parse(JSON.parse(saved));
          assert.equal(receipt.stdout, output);
          assert.equal(receipt.stderr, '');
          assert.ok(saved.length > 32000, 'exercise persisted output beyond the UI preview');
          assert.equal(await persistedToolOutput(store, recordId), saved);
          context.diagnostic(
            `Bash receipt ${saved.length} UTF-16 units; next-request tool_result ${result.text.length} units; middle marker present=${JSON.stringify(request.messages).includes(secret)}`,
          );
          assert.equal(result.isError, false);
          // Keep driving the real page tool even when the summary assertion will fail,
          // so a red run also reports the SDK's actual pagination behavior.
          summary = result.text;
          prematureMarker = JSON.stringify(request.messages).includes(secret);
          const directory = join(root, 'data', 'tool-output');
          const names = await readdir(directory).catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
            throw error;
          });
          const diskOutputs = await Promise.all(
            names.map((name) => readFile(join(directory, name), 'utf8')),
          );
          persistedOnDisk = diskOutputs.includes(saved);
        } else if (nextOffset >= 0) {
          const result = toolResult(request, `toolu_output_page_${pageCount}`);
          assert.equal(
            result.isError,
            false,
            'the summary record ID must be usable by the registered page tool',
          );
          const page = pageSchema.parse(JSON.parse(result.text));
          assert.equal(page.toolCallId, recordId);
          assert.equal(page.offset, nextOffset);
          assert.equal(page.total, saved.length);
          assert.equal(
            page.excerpt,
            saved.slice(nextOffset, nextOffset + limit),
            'offset addresses the complete saved JSON receipt in UTF-16 units',
          );
          assert.equal(
            page.nextOffset,
            nextOffset + limit < saved.length ? nextOffset + limit : null,
          );
          reconstructed += page.excerpt;
          markerRead ||= page.excerpt.includes(secret);
          prematureMarker ||= !markerRead && JSON.stringify(request.messages).includes(secret);
          if (page.nextOffset === null) {
            assert.equal(reconstructed, saved);
            assert.ok(markerRead, 'pagination must actually recover the designated middle marker');
            nextOffset = -1;
            sendModelReply(response, model, [
              {
                name: 'Bash',
                id: shortId,
                input: {
                  command: `printf '%s' '${shortOutput}'`,
                  description: 'Return short synthetic output',
                },
              },
            ]);
            return;
          }
          nextOffset = page.nextOffset;
        } else {
          const result = toolResult(request, shortId);
          assert.equal(result.isError, false);
          assert.equal(
            result.text,
            shortOutput,
            'short native Bash output retains its original SDK response',
          );
          const shortRecord = store.get('tools', `${run.id}:${shortId}`);
          const receipt = receiptSchema.parse(JSON.parse(await files.toolOutput(shortRecord.id)));
          assert.equal(receipt.stdout, shortOutput);
          assert.ok(!result.text.includes('read_tool_output'));
          sendModelReply(response, model, 'SYNTHETIC_OUTPUT_PAGES_VERIFIED');
          return;
        }
        ++pageCount;
        sendModelReply(response, model, [
          {
            name: pageTool,
            id: `toolu_output_page_${pageCount}`,
            input: { toolCallId: recordId, offset: nextOffset, limit },
          },
        ]);
      },
      async ({ projectPath }) => {
        await writeFile(join(projectPath, 'synthetic-output.txt'), output);
      },
    );
    context.diagnostic(
      `read_tool_output returned ${pageCount} real SDK pages; full JSON reconstruction=${reconstructed === saved}; middle marker recovered=${markerRead}; persisted on disk=${persistedOnDisk}`,
    );
    assert.ok(pageCount > 1);
    assert.equal(requestCount, pageCount + 3);
    assert.ok(summary.length <= threshold, 'long Bash receipt must become a bounded summary');
    assert.ok(summary.includes('read_tool_output'), 'summary names the registered reader');
    assert.ok(summary.includes(recordId), 'summary carries the complete persisted record ID');
    assert.equal(
      prematureMarker,
      false,
      'middle output must not leak into model requests before an explicit page read',
    );
    assert.ok(persistedOnDisk, 'the complete JSON receipt exists on local disk');
  },
);

test(
  'real SDK keeps Bash receipts at 6000 UTF-16 units and summarizes 6001 while UTF-8 byte length does not trigger the limit',
  { skip: process.platform !== 'linux', timeout: 40_000 },
  async (context) => {
    const cases = [
      { id: 'toolu_boundary_short', file: 'short.txt', output: 'short baseline' },
      { id: 'toolu_boundary_unicode', file: 'unicode.txt', output: '界'.repeat(2500) },
      { id: 'toolu_boundary_exact', file: 'exact.txt', output: '' },
      { id: 'toolu_boundary_long', file: 'long.txt', output: '' },
    ];
    let requestCount = 0;
    await withSdkFixture(
      context,
      async (request, response, { store, files, projectPath, run }) => {
        ++requestCount;
        if (requestCount > 1) {
          const prior = cases[requestCount - 2];
          assert.ok(prior);
          const result = toolResult(request, prior.id);
          const recordId = `${run.id}:${prior.id}`;
          const saved = await files.toolOutput(recordId);
          assert.equal(await persistedToolOutput(store, recordId), saved);
          const receipt = receiptSchema.parse(JSON.parse(saved));
          assert.equal(receipt.stdout, prior.output);
          assert.equal(receipt.stderr, '');
          assert.equal(result.isError, false);
          if (requestCount === 2) {
            const overhead = JSON.stringify({ ...receipt, stdout: '' }).length;
            const exact = cases[2];
            const long = cases[3];
            assert.ok(exact && long);
            exact.output = 'e'.repeat(threshold - overhead);
            long.output = 'l'.repeat(threshold + 1 - overhead);
            await writeFile(join(projectPath, exact.file), exact.output);
            await writeFile(join(projectPath, long.file), long.output);
          }
          if (prior.id === 'toolu_boundary_exact') assert.equal(saved.length, threshold);
          if (prior.id === 'toolu_boundary_unicode') {
            assert.ok(saved.length < threshold);
            assert.ok(Buffer.byteLength(saved, 'utf8') > threshold);
          }
          if (prior.id === 'toolu_boundary_long') {
            assert.equal(saved.length, threshold + 1);
            context.diagnostic(
              `6001-unit Bash receipt reaches the next request as ${result.text.length} units`,
            );
            assert.ok(result.text.includes('read_tool_output'));
            assert.ok(result.text.includes(recordId));
            assert.ok(result.text.length <= threshold);
          } else {
            assert.equal(
              result.text,
              prior.output,
              'short and exactly-at-threshold Bash results retain native SDK behavior',
            );
          }
        }
        const next = cases[requestCount - 1];
        if (!next) {
          sendModelReply(response, model, 'SYNTHETIC_UTF16_BOUNDARY_VERIFIED');
          return;
        }
        sendModelReply(response, model, [
          {
            name: 'Bash',
            id: next.id,
            input: { command: `cat ${next.file}`, description: 'Read synthetic boundary output' },
          },
        ]);
      },
      async ({ projectPath }) => {
        await Promise.all(
          cases.map(({ file, output }) => writeFile(join(projectPath, file), output)),
        );
      },
    );
    assert.equal(requestCount, cases.length + 1);
  },
);

for (const failed of [false, true]) {
  test(
    `real SDK summarizes project command ${failed ? 'failures' : 'receipts'} and preserves page access and short responses`,
    { skip: !commandsAvailable(), timeout: 40_000 },
    async (context) => {
      const secret = `SYNTHETIC_PROJECT_MIDDLE_${randomUUID()}`;
      const output = 'x'.repeat(7000) + secret + '界𠮷'.repeat(2000);
      const commandId = 'toolu_project_long';
      const pageId = 'toolu_project_page';
      const shortId = 'toolu_project_short';
      const shortOutput = 'short project response';
      let requestCount = 0;
      let saved = '';
      let recordId = '';
      let offset = 0;
      const limit = 200;
      await withSdkFixture(
        context,
        async (request, response, { store, files, run }) => {
          ++requestCount;
          if (requestCount === 1) {
            assert.ok(request.tools.some(({ name }) => name === 'mcp__atelier__run_command'));
            sendModelReply(response, model, [
              {
                name: 'mcp__atelier__run_command',
                id: commandId,
                input: {
                  command: `cat synthetic-output.txt${failed ? '; exit 7' : ''}`,
                  reason: 'Read synthetic project output in the isolated sandbox',
                },
              },
            ]);
          } else if (requestCount === 2) {
            const result = toolResult(request, commandId);
            assert.equal(result.isError, failed, 'long failures keep their error status');
            recordId = `${run.id}:${commandId}`;
            const record = store.get('tools', recordId);
            assert.equal(record.status, failed ? 'failed' : 'succeeded');
            saved = await files.toolOutput(recordId);
            if (failed) assert.equal(saved, `命令退出 7\n${output}`);
            else assert.deepEqual(JSON.parse(saved), { output, code: 0, truncated: false });
            assert.ok(saved.length > threshold && saved.length < 32000);
            context.diagnostic(
              `project ${failed ? 'failure' : 'success'} receipt ${saved.length} UTF-16 units; next-request tool_result ${result.text.length} units`,
            );
            assert.ok(result.text.length <= threshold);
            assert.ok(result.text.includes('read_tool_output'));
            assert.ok(result.text.includes(recordId));
            assert.equal(JSON.stringify(request.messages).includes(secret), false);
            assert.ok(
              request.tools.some(({ name }) => name === pageTool),
              'project mode registers the advertised page tool',
            );
            assert.equal(
              await persistedToolOutput(store, recordId),
              saved,
              'long project output can be read from a separately opened local store',
            );
            offset = saved.indexOf(secret) - 20;
            assert.ok(offset > 0);
            sendModelReply(response, model, [
              { name: pageTool, id: pageId, input: { toolCallId: recordId, offset, limit } },
            ]);
          } else if (requestCount === 3) {
            const result = toolResult(request, pageId);
            assert.equal(
              result.isError,
              false,
              'reading a failed command result is a successful page read',
            );
            const page = pageSchema.parse(JSON.parse(result.text));
            assert.equal(page.toolCallId, recordId);
            assert.equal(page.excerpt, saved.slice(offset, offset + limit));
            assert.equal(page.nextOffset, offset + limit);
            assert.ok(page.excerpt.includes(secret));
            sendModelReply(response, model, [
              {
                name: 'mcp__atelier__run_command',
                id: shortId,
                input: {
                  command: `printf '%s' '${shortOutput}'`,
                  reason: 'Return short synthetic output',
                },
              },
            ]);
          } else if (requestCount === 4) {
            const result = toolResult(request, shortId);
            assert.equal(result.isError, false);
            assert.equal(
              result.text,
              JSON.stringify({ output: shortOutput, code: 0, truncated: false }),
            );
            assert.equal(result.text, await files.toolOutput(`${run.id}:${shortId}`));
            assert.ok(
              store
                .list('permissions')
                .every(
                  ({ status, decisionSource }) =>
                    status === 'allowed' && decisionSource === 'automatic',
                ),
            );
            sendModelReply(response, model, [
              {
                name: pageTool,
                id: 'toolu_no_grant',
                input: { toolCallId: `${run.id}:${shortId}`, query: 'project response' },
              },
            ]);
          } else if (requestCount === 5) {
            assert.equal(toolResult(request, 'toolu_no_grant').isError, true);
            sendModelReply(response, model, [
              { name: pageTool, id: 'toolu_default_page', input: { toolCallId: recordId } },
            ]);
          } else {
            assert.equal(requestCount, 6);
            const defaults = pageSchema.parse(
              JSON.parse(toolResult(request, 'toolu_default_page').text),
            );
            assert.equal(defaults.offset, 0);
            assert.equal(defaults.total, saved.length);
            assert.equal(defaults.excerpt, saved.slice(0, 2000));
            assert.equal(defaults.nextOffset, 2000);
            sendModelReply(response, model, 'SYNTHETIC_PROJECT_OUTPUT_VERIFIED');
          }
        },
        async ({ projectPath }) => {
          await writeFile(join(projectPath, 'synthetic-output.txt'), output);
        },
        { executor: 'project-v1', approvalMode: 'automatic' },
      );
      assert.equal(requestCount, 6);
    },
  );
}
