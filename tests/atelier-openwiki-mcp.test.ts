/**
 * @file 验证工作台通过 stdio 适配器调用 OpenWiki 生命周期工具。
 * @implementation 使用临时 Git 仓库和有状态上游替身，按连接核对调用轨迹。
 * @updated 2026-11-27T00:00:00Z
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { callMcp, McpSessions, testMcp } from '../server/extension-mcp.js';
import type { EnabledMcp } from '../server/extensions.js';

const launcher = fileURLToPath(new URL('../scripts/atelier-openwiki-mcp.mts', import.meta.url));
const upstream = fileURLToPath(
  new URL('./fixtures/atelier-openwiki-upstream.mjs', import.meta.url),
);
const lifecycle = [
  'openwiki_begin',
  'openwiki_finish',
  'openwiki_inspect_page_claims',
  'openwiki_next_page',
  'openwiki_submit_page',
  'openwiki_submit_plan',
];
const settings = { mode: 'update', language: 'zh-CN' };
const toolCall = (name: string, args: Record<string, unknown>) => ({ name, args });
type Trace = { connection: string } & (
  | { event: 'start'; cwd: string; argv: string[] }
  | { event: 'list' }
  | ({ event: 'call' } & ReturnType<typeof toolCall>)
);

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-openwiki-mcp-'));
  const sessions = new McpSessions();
  const oldHome = process.env.HOME;
  t.after(async () => {
    try {
      await sessions.shutdown();
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      await rm(directory, { recursive: true, force: true });
    }
  });

  const temp = await realpath(directory);
  const home = join(temp, 'home');
  await mkdir(home);
  async function initRepo(name: string) {
    const path = join(temp, name);
    await mkdir(path);
    execFileSync('git', ['init', '--quiet', '--template='], {
      cwd: path,
      env: { HOME: home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'pipe',
      timeout: 5_000,
    });
    return path;
  }
  const root = await initRepo('checkout');
  const cwd = join(root, 'nested');
  await mkdir(cwd);
  const command = join(temp, 'openwiki-fixture');
  await writeFile(
    command,
    `#!/bin/sh\nexec ${[process.execPath, upstream, root].map(shellQuote).join(' ')} "$@"\n`,
    { flag: 'wx', mode: 0o700 },
  );

  // Top-level tests in this file run serially. The SDK inherits this HOME for both subprocesses.
  process.env.HOME = home;
  const server = {
    kind: 'mcp',
    id: 'openwiki-fixture',
    projectId: 'openwiki-fixture-project',
    name: 'openwiki',
    description: '',
    source: 'fixture',
    enabled: true,
    version: 1,
    transport: {
      type: 'stdio',
      command: process.execPath,
      args: [launcher, command],
      envNames: [],
      keepAlive: true,
    },
    tools: [],
    allowedTools: lifecycle.map((name) => ({ name, access: 'approval' })),
  } satisfies EnabledMcp;
  const discovered = await testMcp(server, cwd, AbortSignal.timeout(10_000));
  assert.equal(discovered.status, 'connected', discovered.statusMessage);
  const call = (name: string, args: Record<string, unknown>, keepAlive = true) =>
    callMcp(
      { ...server, ...discovered, transport: { ...server.transport, keepAlive } },
      cwd,
      name,
      args,
      AbortSignal.timeout(12_000),
      undefined,
      sessions,
    );
  const beginArgs = { root, ...settings };
  async function begin() {
    const receipt = JSON.parse(await call('openwiki_begin', beginArgs));
    assert.equal(receipt.status, 'active');
    assert.ok(typeof receipt.runId === 'string' && receipt.runId.length > 0);
    return receipt.runId as string;
  }
  async function trace(): Promise<Trace[]> {
    const text = await readFile(join(temp, 'upstream.jsonl'), 'utf8');
    return text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
  }
  async function calls() {
    return (await trace()).flatMap((entry) =>
      entry.event === 'call' ? [toolCall(entry.name, entry.args)] : [],
    );
  }
  async function callBatches() {
    const events = await trace();
    return events
      .filter((entry) => entry.event === 'start')
      .map(({ connection }) =>
        events.flatMap((entry) =>
          entry.event === 'call' && entry.connection === connection
            ? [toolCall(entry.name, entry.args)]
            : [],
        ),
      );
  }
  return {
    root,
    cwd,
    initRepo,
    discovered,
    beginArgs,
    begin,
    call,
    trace,
    calls,
    callBatches,
    stateFile: join(root, 'openwiki', '.run.json'),
    close: () => sessions.close(server.id),
  };
}

test('OpenWiki discovery exposes only lifecycle tools without starting a Wiki run', async (t) => {
  const fixture = await setup(t);
  assert.deepEqual(
    fixture.discovered.tools.map(({ name }) => name),
    lifecycle,
  );
  const events = await fixture.trace();
  assert.deepEqual(
    events.map(({ event }) => event),
    ['start', 'list'],
  );
  assert.deepEqual(events[0], {
    event: 'start',
    connection: events[1]?.connection,
    cwd: fixture.root,
    argv: ['mcp', '--host', 'claude'],
  });
  await assert.rejects(stat(join(fixture.root, 'openwiki')), { code: 'ENOENT' });
});

test('OpenWiki uses one live connection and restores the same run on each ephemeral call', async (t) => {
  const fixture = await setup(t);
  const runId = await fixture.begin();
  const saved = { schemaVersion: 1, runId, ...settings };
  assert.deepEqual(JSON.parse(await readFile(fixture.stateFile, 'utf8')), saved);

  const plan = toolCall('openwiki_submit_plan', { runId, plan: 'fixture plan' });
  const next = toolCall('openwiki_next_page', { runId });
  for (const { name, args } of [plan, next]) {
    assert.deepEqual(JSON.parse(await fixture.call(name, args)), { tool: name, runId });
  }
  await fixture.close();

  const path = 'fixture.md';
  const claims = toolCall('openwiki_inspect_page_claims', { runId, path });
  const page = toolCall('openwiki_submit_page', { runId, path, markdown: 'fixture page' });
  const finish = toolCall('openwiki_finish', { runId });
  for (const { name, args } of [claims, page, finish]) {
    assert.deepEqual(JSON.parse(await fixture.call(name, args, false)), { tool: name, runId });
  }
  const begin = toolCall('openwiki_begin', fixture.beginArgs);
  assert.deepEqual(await fixture.callBatches(), [
    [],
    [begin, plan, next],
    [begin, claims],
    [begin, page],
    [begin, finish],
  ]);
  assert.deepEqual(JSON.parse(await readFile(fixture.stateFile, 'utf8')), saved);
});

test('OpenWiki rejects other roots and wrong run IDs without forwarding a tool call', async (t) => {
  const fixture = await setup(t);
  const otherRepo = await fixture.initRepo('other-checkout');
  for (const root of [otherRepo, fixture.cwd]) {
    await assert.rejects(fixture.call('openwiki_begin', { ...settings, root }), {
      code: 'MCP_TOOL_FAILED',
      message: /Git top-level/,
    });
  }
  assert.deepEqual(await fixture.calls(), []);
  await assert.rejects(stat(join(otherRepo, 'openwiki')), { code: 'ENOENT' });
  await assert.rejects(stat(fixture.stateFile), { code: 'ENOENT' });

  const runId = await fixture.begin();
  await fixture.close();
  await assert.rejects(fixture.call('openwiki_next_page', { runId: `${runId}-wrong` }, false), {
    code: 'MCP_TOOL_FAILED',
    message: /No matching saved OpenWiki run/,
  });
  await assert.rejects(fixture.call('openwiki_next_page', { runId, root: fixture.root }, false), {
    code: 'MCP_TOOL_FAILED',
    message: /do not pass root/,
  });
  assert.deepEqual(await fixture.calls(), [toolCall('openwiki_begin', fixture.beginArgs)]);
});

test('OpenWiki reports an upstream tool error without replaying the page write', async (t) => {
  const fixture = await setup(t);
  const runId = await fixture.begin();
  await fixture.close();

  const page = toolCall('openwiki_submit_page', {
    runId,
    path: 'fixture.md',
    markdown: 'fixture-tool-error',
  });
  await assert.rejects(fixture.call(page.name, page.args, false), {
    code: 'MCP_TOOL_FAILED',
    message: /fixture submit failed after receiving the page/,
  });
  const begin = toolCall('openwiki_begin', fixture.beginArgs);
  assert.deepEqual(await fixture.callBatches(), [[], [begin], [begin, page]]);
});
