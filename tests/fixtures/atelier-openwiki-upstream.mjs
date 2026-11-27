/**
 * @file 为 atelier OpenWiki 集成测试提供有进程内活动运行的上游替身。
 * @implementation 仅在测试临时目录写入模拟状态与跨连接调用轨迹。
 * @updated 2026-11-27T00:00:00Z
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const [root, ...argv] = process.argv.slice(2);
assert.equal(process.cwd(), root, 'upstream must start at the fixture Git root');
assert.equal(process.env.HOME, join(root, '..', 'home'));
assert.deepEqual(argv, ['mcp', '--host', 'claude']);

const wiki = join(root, 'openwiki');
const stateFile = join(wiki, '.run.json');
const traceFile = join(root, '..', 'upstream.jsonl');
const connection = randomUUID();
const record = (event) =>
  appendFileSync(traceFile, JSON.stringify({ connection, ...event }) + '\n');
record({ event: 'start', cwd: process.cwd(), argv });

const fields = {
  openwiki_begin: ['root', 'mode', 'language'],
  openwiki_submit_plan: ['runId', 'plan'],
  openwiki_next_page: ['runId'],
  openwiki_inspect_page_claims: ['runId', 'path'],
  openwiki_submit_page: ['runId', 'path', 'markdown'],
  openwiki_finish: ['runId'],
  openwiki_fixture_debug: [],
};
const tools = Object.entries(fields).map(([name, keys]) => ({
  name,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
    required: keys,
  },
}));
const result = (body) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const failure = (text) => ({ isError: true, content: [{ type: 'text', text }] });
const server = new Server(
  { name: 'openwiki-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// A fresh upstream process cannot use saved state until it receives its own begin.
let activeRun;
server.setRequestHandler(ListToolsRequestSchema, () => {
  record({ event: 'list' });
  return { tools };
});
server.setRequestHandler(CallToolRequestSchema, ({ params: { name, arguments: args = {} } }) => {
  record({ event: 'call', name, args });
  if (name === 'openwiki_begin') {
    const { root: requestedRoot, mode, language } = args;
    if (requestedRoot !== root || !['init', 'update'].includes(mode) || !language) {
      return failure('invalid fixture begin');
    }
    if (existsSync(stateFile)) {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (saved.schemaVersion !== 1 || saved.mode !== mode || saved.language !== language) {
        return failure('fixture begin did not use the saved settings');
      }
      activeRun = saved.runId;
    } else {
      activeRun = randomUUID();
      mkdirSync(wiki, { recursive: true });
      writeFileSync(
        stateFile,
        JSON.stringify({ schemaVersion: 1, runId: activeRun, mode, language }),
        {
          flag: 'wx',
        },
      );
    }
    return result({ status: 'active', runId: activeRun });
  }
  if (!activeRun || args.runId !== activeRun) return failure('no active run on this connection');
  if (name === 'openwiki_submit_page' && args.markdown === 'fixture-tool-error') {
    return failure('fixture submit failed after receiving the page');
  }
  if (name === 'openwiki_finish') activeRun = undefined;
  return result({ tool: name, runId: args.runId });
});
await server.connect(new StdioServerTransport());
