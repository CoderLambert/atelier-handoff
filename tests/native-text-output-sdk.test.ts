/**
 * @file 独立验证锁定 SDK 的原生文本工具在下一次模型请求中的真实回执。
 * @implementation 以回环模型核对原生文件行范围、搜索统计、Bash 失败回执，以及独立保存的命令日志在检索和分页时的坐标。
 * @updated 2026-11-22T21:17:02+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentRunner } from '../server/agent.js';
import { FileRecords } from '../server/artifacts.js';
import { PermissionService } from '../server/permissions.js';
import { Store } from '../server/store.js';
import { emptyDraft, now, type Run } from '../shared/types.js';
import { sendModelReply, type FixtureTool } from './fixtures/subagent-gateway.js';

const model = 'fixture-native-text-output';
const pageTool = 'mcp__atelier__read_tool_output';
const threshold = 6000;
const requestSchema = z.object({
  model: z.literal(model),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  system: z.unknown().optional(),
  tools: z.array(z.object({ name: z.string() })),
});
const resultSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))]),
  is_error: z.boolean().optional(),
});
const textSchema = z.object({ type: z.literal('text'), text: z.string() });
const readSchema = z.object({
  type: z.literal('text'),
  file: z.object({
    content: z.string(),
    numLines: z.number(),
    startLine: z.number(),
    totalLines: z.number(),
  }),
});
const pathsSchema = z.object({
  filenames: z.array(z.string()),
  numFiles: z.number(),
  truncated: z.boolean().optional(),
  totalMatches: z.number().optional(),
  countIsComplete: z.boolean().optional(),
  totalFiles: z.number().optional(),
  content: z.string().optional(),
  numLines: z.number().optional(),
  numMatches: z.number().optional(),
  totalLines: z.number().optional(),
});
const pageSchema = z.object({ toolCallId: z.string(), excerpt: z.string() });
type Observation = {
  recordId: string;
  saved: string;
  status: string;
  text: string;
  isError: boolean;
  additionalContext: string;
  messages: string;
};
type Fixture = {
  projectPath: string;
  observations: Map<string, Observation>;
};
type Step = { id: string; name: string; input: (fixture: Fixture) => Record<string, unknown> };

function observed(fixture: Fixture, id: string): Observation {
  const value = fixture.observations.get(id);
  assert.ok(value, `missing model-facing observation for ${id}`);
  return value;
}

// The existing withSdkFixture is private to tool-output-context-sdk.test.ts. Keep
// the same AgentRunner boundary here and reuse its shared SSE responder verbatim.
async function nativeFixture(
  context: TestContext,
  steps: Step[],
  setup: (fixture: Fixture) => Promise<void>,
): Promise<Fixture> {
  const sdkPackage = join(
    dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))),
    'package.json',
  );
  const version = z
    .object({ version: z.literal('0.3.332') })
    .parse(JSON.parse(await readFile(sdkPackage, 'utf8'))).version;
  context.diagnostic(`real SDK ${version}; loopback model responses; paid model requests=0`);
  const root = await mkdtemp(join(tmpdir(), 'atelier-native-text-sdk-'));
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
  const fixture: Fixture = { projectPath: join(root, 'project'), observations: new Map() };
  await Promise.all(
    [fixture.projectPath, isolatedEnvironment.HOME, isolatedEnvironment.TMPDIR].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  Object.assign(process.env, isolatedEnvironment);
  const store = new Store(join(root, 'data'));
  const files = new FileRecords(store);
  const runner = new AgentRunner(store, new PermissionService(store), files);
  const project = store.put('projects', {
    id: randomUUID(),
    name: 'Synthetic native text fixture',
    path: fixture.projectPath,
    branch: '',
    available: true,
    createdAt: now(),
  });
  const session = store.put('sessions', {
    id: randomUUID(),
    projectId: project.id,
    title: 'Synthetic native text fixture',
    status: 'active',
    sdkSessionId: null,
    draft: emptyDraft(),
    createdAt: now(),
    updatedAt: now(),
  });
  const failures: unknown[] = [];
  let turn = 0;
  let run: Run;
  const gateway = createServer(async (request, response) => {
    try {
      assert.equal(new URL(request.url ?? '/', 'http://127.0.0.1').pathname, '/v1/messages');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const parsed = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.ok(turn <= steps.length, 'unexpected extra model turn');
      const prior = steps[turn - 1];
      if (prior) {
        const blocks: unknown[] = [
          ...parsed.messages,
          { role: 'system', content: parsed.system },
        ].flatMap(({ content }) =>
          typeof content === 'string'
            ? [{ type: 'text', text: content }]
            : Array.isArray(content)
              ? content
              : [],
        );
        const results = blocks.flatMap((block) => {
          const result = resultSchema.safeParse(block);
          return result.success && result.data.tool_use_id === prior.id ? [result.data] : [];
        });
        assert.equal(results.length, 1, `exactly one tool_result for ${prior.id}`);
        const result = results[0];
        assert.ok(result);
        const recordId = `${run.id}:${prior.id}`;
        const saved = await files.toolOutput(recordId);
        const additionalContext = blocks
          .flatMap((block) => {
            const text = textSchema.safeParse(block);
            return text.success &&
              /PostToolUse(?:Failure)?:.* hook additional context:/.test(text.data.text) &&
              text.data.text.includes(recordId)
              ? [text.data.text]
              : [];
          })
          .join('\n');
        const observation: Observation = {
          recordId,
          saved,
          status: store.get('tools', recordId).status,
          text:
            typeof result.content === 'string'
              ? result.content
              : result.content.map(({ text }) => text).join('\n'),
          isError: result.is_error === true,
          additionalContext,
          messages: JSON.stringify(parsed.messages),
        };
        fixture.observations.set(prior.id, observation);
        context.diagnostic(
          `${prior.name} ${prior.id}: saved=${saved.length}; tool_result=${observation.text.length}; is_error=${observation.isError}; exactRecordIdInRequest=${observation.messages.includes(recordId)}; hookContext=${additionalContext.length} units; exactRecordIdInHook=${additionalContext.includes(recordId)}`,
        );
      }
      const next = steps[turn++];
      if (!next) {
        sendModelReply(response, model, 'SYNTHETIC_NATIVE_TEXT_CAPTURED');
        return;
      }
      assert.ok(
        parsed.tools.some(({ name }) => name === next.name),
        `${next.name} is registered`,
      );
      const tool: FixtureTool = { id: next.id, name: next.name, input: next.input(fixture) };
      sendModelReply(response, model, [tool]);
    } catch (error) {
      failures.push(error);
      sendModelReply(response, model, 'SYNTHETIC_NATIVE_TEXT_ASSERTION_FAILED');
    }
  });
  try {
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const address = gateway.address();
    assert.ok(address && typeof address === 'object');
    run = store.put('runs', {
      id: randomUUID(),
      projectId: project.id,
      sessionId: session.id,
      executor: 'native-v1',
      prompt: 'Run the synthetic native text fixture.',
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
        maxTurns: steps.length + 2,
        timeoutMs: 30_000,
      },
    });
    await setup(fixture);
    await runner.start(run, run.prompt);
    assert.deepEqual(failures, []);
    const finished = store.get('runs', run.id);
    assert.equal(finished.status, 'completed', finished.error ?? undefined);
    assert.equal(turn, steps.length + 1);
    assert.equal(store.list('permissions').length, 0);
    return fixture;
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

function assertPointer(observation: Observation) {
  const delivered = [observation.text, observation.additionalContext].join('\n');
  assert.ok(delivered.includes(pageTool), 'tool_result or hook context names the page reader');
  assert.ok(
    delivered.includes(observation.recordId),
    'tool_result or hook context contains the precise stored record ID',
  );
  assert.ok(
    delivered.includes(`${observation.saved.length} 个 UTF-16`),
    'pointer length describes the complete original stored receipt',
  );
}

const sdkOptions = { skip: process.platform !== 'linux', timeout: 40_000 };

test(
  'native Read delivers whole-file and explicit long-range results without a second preview cap',
  sdkOptions,
  async (context) => {
    const marker = `SYNTHETIC_READ_MIDDLE_${randomUUID()}`;
    const lines = Array.from({ length: 600 }, (_, index) =>
      index === 299
        ? marker
        : `ROW_${String(index + 1).padStart(4, '0')} abcdefghijklmnopqrstuvwxyz`,
    );
    const output = lines.join('\n');
    const fixture = await nativeFixture(
      context,
      [
        {
          id: 'toolu_read_first',
          name: 'Read',
          input: ({ projectPath }) => ({ file_path: join(projectPath, 'long.txt') }),
        },
        {
          id: 'toolu_read_range',
          name: 'Read',
          input: ({ projectPath }) => ({
            file_path: join(projectPath, 'long.txt'),
            offset: 220,
            limit: 240,
          }),
        },
        {
          id: 'toolu_read_saved_page',
          name: pageTool,
          input: (current) => {
            const first = observed(current, 'toolu_read_first');
            return {
              toolCallId: first.recordId,
              offset: first.saved.indexOf(marker) - 20,
              limit: 200,
            };
          },
        },
      ],
      async ({ projectPath }) => {
        await writeFile(join(projectPath, 'long.txt'), output);
      },
    );
    const first = observed(fixture, 'toolu_read_first');
    const range = observed(fixture, 'toolu_read_range');
    const page = observed(fixture, 'toolu_read_saved_page');
    const receipt = readSchema.parse(JSON.parse(first.saved));
    const rangeReceipt = readSchema.parse(JSON.parse(range.saved));
    context.diagnostic(
      `Read: full result ${first.text.length} units; range result ${range.text.length} units; source=${receipt.file.totalLines} lines; range=${rangeReceipt.file.numLines} lines`,
    );
    assert.equal(receipt.file.content, output);
    assert.equal(receipt.file.numLines, 600);
    assert.equal(receipt.file.totalLines, 600);
    assert.equal(first.isError, false);
    assert.ok(first.text.includes(marker), 'first native Read delivers the middle evidence');
    assert.match(first.text, /600\tROW_0600/);
    assert.equal(range.isError, false);
    assert.equal(rangeReceipt.file.startLine, 220);
    assert.equal(rangeReceipt.file.numLines, 240);
    assert.equal(rangeReceipt.file.content, lines.slice(219, 459).join('\n'));
    assert.ok(range.text.length > threshold, 'explicit range can exceed the generic receipt limit');
    assert.ok(range.text.includes(marker), 'the requested range includes the middle evidence');
    assert.match(range.text, /220\tROW_0220/);
    assert.match(range.text, /459\tROW_0459/);
    assert.doesNotMatch(range.text, /(?:219\tROW_0219|460\tROW_0460)/);
    assert.equal(first.additionalContext, '');
    assert.equal(range.additionalContext, '');
    assert.ok(pageSchema.parse(JSON.parse(page.text)).excerpt.includes(marker));
    assert.equal(page.isError, false);
  },
);

async function setupPaths({ projectPath }: Fixture) {
  const folder = join(projectPath, 'matches');
  await mkdir(folder);
  await Promise.all(
    Array.from({ length: 80 }, (_, index) =>
      writeFile(
        join(folder, `${String(index).padStart(3, '0')}-${'synthetic-path-'.repeat(5)}.txt`),
        'SYNTHETIC_MATCH\nSYNTHETIC_MATCH\nSYNTHETIC_MATCH\n',
      ),
    ),
  );
}

test(
  'native Glob preserves exact total count while its model-facing paths are shortened',
  sdkOptions,
  async (context) => {
    const fixture = await nativeFixture(
      context,
      [
        {
          id: 'toolu_glob',
          name: 'Glob',
          input: ({ projectPath }) => ({ path: projectPath, pattern: 'matches/*.txt' }),
        },
      ],
      setupPaths,
    );
    const result = observed(fixture, 'toolu_glob');
    const receipt = pathsSchema.parse(JSON.parse(result.saved));
    context.diagnostic(
      `Glob: totalMatches=${receipt.totalMatches}; original numFiles=${receipt.numFiles}; displayed paths=${receipt.filenames.filter((path) => result.text.includes(path)).length}; exact total in model result=${result.text.includes('of 80 matching files')}`,
    );
    assert.equal(receipt.numFiles, 80);
    assert.equal(receipt.filenames.length, 80);
    assert.equal(receipt.totalMatches, 80);
    assert.equal(receipt.countIsComplete, true);
    assert.equal(receipt.truncated, false);
    assert.ok(result.saved.length > threshold);
    assert.ok(result.text.length <= threshold);
    assert.equal(result.isError, false);
    assertPointer(result);
    assert.match(result.text, /80/, 'Glob still tells the model the true number of matching files');
    assert.match(
      result.text,
      /truncat|limit|not listed|部分|截断/i,
      'Glob indicates that the displayed paths are incomplete',
    );
    assert.equal(receipt.filenames.filter((path) => result.text.includes(path)).length, 8);
  },
);

for (const mode of ['files_with_matches', 'content', 'count'] as const) {
  test(
    `native Grep ${mode} preserves match counts and marks shortened results`,
    sdkOptions,
    async (context) => {
      const fixture = await nativeFixture(
        context,
        [
          {
            id: 'toolu_grep',
            name: 'Grep',
            input: ({ projectPath }) => ({
              path: join(projectPath, 'matches'),
              pattern: 'SYNTHETIC_MATCH',
              output_mode: mode,
              head_limit: 0,
            }),
          },
        ],
        setupPaths,
      );
      const result = observed(fixture, 'toolu_grep');
      const receipt = pathsSchema.parse(JSON.parse(result.saved));
      const delivered = [result.text, result.additionalContext].join('\n');
      context.diagnostic(
        `Grep ${mode}: source files=${receipt.numFiles}; source matching lines=${receipt.numLines ?? 'n/a'}; source occurrences=${receipt.numMatches ?? 'n/a'}; count 240/80 delivered=${result.text.includes('Found 240 total occurrences across 80 files')}; truncation notice delivered=${/truncat|limit|部分|截断/i.test(delivered)}`,
      );
      assert.ok(result.saved.length > threshold);
      assert.equal(result.isError, false);
      assert.ok(result.text.length <= threshold);
      if (mode === 'files_with_matches') {
        assert.equal(receipt.numFiles, 80);
        assert.equal(receipt.filenames.length, 80);
        assert.match(
          result.text,
          /80/,
          'Grep still reports all 80 matching files after showing only eight paths',
        );
        assert.match(
          delivered,
          /truncat|limit|部分|截断/i,
          'Grep explicitly marks the shortened path list',
        );
      } else if (mode === 'count') {
        assert.equal(receipt.numMatches, 240);
        assert.equal(receipt.numFiles, 80);
        assert.match(
          result.text,
          /Found 240 total occurrences across 80 files/,
          'Grep still reports the exact 240 matches across 80 files after shortening the count rows',
        );
      } else {
        assert.equal(receipt.numLines, 240);
        assert.match(
          delivered,
          /240/,
          'Grep still reports 240 matching lines after shortening the content',
        );
        assert.match(
          delivered,
          /truncat|limit|部分|截断/i,
          'Grep explicitly marks shortened content',
        );
      }
      assertPointer(result);
    },
  );
}

test(
  'Bash spill can be searched and paged in log coordinates while keeping its original receipt',
  sdkOptions,
  async (context) => {
    const item = 'toolu_build_spill';
    const query = 'PHASE rollback';
    const ticket = `BLD-${randomUUID()}`;
    const noise = Array.from(
      { length: 1900 },
      (_, index) => `batch ${index}: ${'synthetic build detail '.repeat(4)}`,
    );
    noise[950] = `${query} module=stone_api ticket=${ticket}`;
    const source = noise.join('\n') + '\n';
    const hitSchema = z.object({
      view: z.literal('log'),
      bashLog: z.object({ status: z.literal('complete'), bytes: z.number() }),
      matches: z.array(z.object({ line: z.number(), offset: z.number(), excerpt: z.string() })),
    });
    const fixture = await nativeFixture(
      context,
      [
        {
          id: item,
          name: 'Bash',
          input: () => ({ command: 'cat build.log', description: 'Read the synthetic build log' }),
        },
        {
          id: 'toolu_lookup',
          name: pageTool,
          input: (f) => ({ toolCallId: observed(f, item).recordId, query }),
        },
        {
          id: 'toolu_hit_page',
          name: pageTool,
          input: (f) => {
            const found = hitSchema.parse(JSON.parse(observed(f, 'toolu_lookup').text)).matches[0];
            assert.ok(found);
            return {
              toolCallId: observed(f, item).recordId,
              view: 'log',
              offset: found.offset,
              limit: 150,
            };
          },
        },
      ],
      async ({ projectPath }) => {
        await writeFile(join(projectPath, 'build.log'), source);
      },
    );
    const first = observed(fixture, item);
    assert.ok(!first.saved.includes(ticket) && !first.messages.includes(ticket));
    assert.ok(first.messages.includes('query') && first.messages.includes(first.recordId));
    const result = observed(fixture, 'toolu_lookup');
    const search = hitSchema.parse(JSON.parse(result.text));
    assert.equal(search.bashLog.bytes, Buffer.byteLength(source));
    assert.equal(search.matches.length, 1);
    const [hit] = search.matches;
    assert.ok(hit && hit.excerpt.includes(ticket));
    assert.equal(hit.line, 951);
    assert.equal(hit.offset, source.indexOf(query));
    assert.ok(result.text.length < 2200);
    assert.equal(
      pageSchema.parse(JSON.parse(observed(fixture, 'toolu_hit_page').text)).excerpt,
      source.slice(hit.offset, hit.offset + 150),
    );
  },
);

test(
  'native nonzero Bash preserves SDK failure text and delivers a working stored-output pointer',
  sdkOptions,
  async (context) => {
    const marker = `SYNTHETIC_BASH_MIDDLE_${randomUUID()}`;
    const output =
      'begin\n' + 'abcdefghij\n'.repeat(350) + marker + '\n' + 'klmnopqrst\n'.repeat(350) + 'end\n';
    const fixture = await nativeFixture(
      context,
      [
        {
          id: 'toolu_bash_failure',
          name: 'Bash',
          input: () => ({
            command: 'cat failure.txt; exit 7',
            description: 'Emit isolated synthetic failure output',
          }),
        },
        {
          id: 'toolu_bash_failure_page',
          name: pageTool,
          input: (current) => {
            const failure = observed(current, 'toolu_bash_failure');
            return {
              toolCallId: failure.recordId,
              offset: failure.saved.indexOf(marker) - 20,
              limit: 200,
            };
          },
        },
      ],
      async ({ projectPath }) => {
        await writeFile(join(projectPath, 'failure.txt'), output);
      },
    );
    const result = observed(fixture, 'toolu_bash_failure');
    const page = observed(fixture, 'toolu_bash_failure_page');
    context.diagnostic(
      `Bash nonzero: complete stdout in tool_result=${result.text.includes(output.trimEnd())}; middle in request=${result.messages.includes(marker)}; saved text equals model result=${result.saved === result.text}; explicit page recovered marker=${pageSchema.parse(JSON.parse(page.text)).excerpt.includes(marker)}`,
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.isError, true);
    assert.ok(result.saved.includes(output.trimEnd()));
    assert.match(result.text, /(?:exit|code|退出).*7/i);
    assertPointer(result);
    assert.equal(page.isError, false);
    assert.ok(pageSchema.parse(JSON.parse(page.text)).excerpt.includes(marker));
    // The pinned SDK's PostToolUseFailure supports additionalContext only.
    // Capture this native limit explicitly: a pointer does not replace the error.
    assert.ok(result.text.length > threshold && result.text.length < 10_000);
    assert.equal(result.text, result.saved, 'SDK failure text reaches the model verbatim');
    assert.ok(
      result.text.includes(output.trimEnd()),
      'the model receives the complete long stdout',
    );
    assert.equal(
      result.messages.includes(marker),
      true,
      'the original middle is already in the native failure result',
    );
  },
);

test(
  'native WebFetch long receipt requires a deterministic local fetch fixture',
  {
    skip: 'No existing deterministic local WebFetch transport fixture; external requests are outside this probe.',
  },
  () => {},
);
