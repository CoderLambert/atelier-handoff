/**
 * @file 为 atelier 项目扩展提供 OpenWiki 文档工作流的 stdio 入口。
 * @implementation 复用一个上游连接；重连后只用 OpenWiki 官方 begin 恢复匹配的持久运行，不重放页面操作。
 * @updated 2026-11-27T00:00:00Z
 */
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const begin = 'openwiki_begin';
const finish = 'openwiki_finish';
const lifecycle = new Set([
  begin,
  'openwiki_submit_plan',
  'openwiki_next_page',
  'openwiki_inspect_page_claims',
  'openwiki_submit_page',
  finish,
]);
const savedRun = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  mode: z.enum(['init', 'update']),
  language: z.string().min(1),
});
const beginResult = z.object({ status: z.literal('active'), runId: z.string().min(1) });
const maxStateSize = 1024 * 1024;

function activeRunId(result: CallToolResult) {
  if (result.isError) return undefined;
  const structured = beginResult.safeParse(result.structuredContent);
  if (structured.success) return structured.data.runId;
  for (const item of result.content) {
    if (item.type !== 'text') continue;
    try {
      const parsed = beginResult.safeParse(JSON.parse(item.text));
      if (parsed.success) return parsed.data.runId;
    } catch {
      // A plain-text diagnostic is not an active run receipt.
    }
  }
  return undefined;
}

async function readSavedRun(root: string) {
  const directory = join(root, 'openwiki');
  // Do not follow a Wiki or state-file link outside the authorized checkout.
  if ((await realpath(directory)) !== directory) throw new Error('Unexpected OpenWiki directory.');
  const file = await open(
    join(directory, '.run.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile()) throw new Error('Unexpected OpenWiki state file.');
    const buffer = Buffer.alloc(maxStateSize + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxStateSize) throw new Error('OpenWiki state file exceeds the size limit.');
    return savedRun.parse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
  } finally {
    await file.close();
  }
}

function reject(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

const command = process.argv[2];
if (!command || !isAbsolute(command) || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/atelier-openwiki-mcp.mts /absolute/path/to/openwiki');
}
const root = await realpath(
  execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 5000,
  }).replace(/\r?\n$/, ''),
);
const upstream = new Client({ name: 'atelier-openwiki', version: '1.0.0' });
const downstream = new Server(
  { name: 'atelier-openwiki', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
const transport = new StdioClientTransport({
  command,
  args: ['mcp', '--host', 'claude'],
  cwd: root,
});
let shutdown: Promise<unknown> | undefined;
const close = () =>
  (shutdown ??= Promise.resolve().then(() =>
    Promise.allSettled([downstream.close(), upstream.close()]),
  ));
upstream.onclose = () => void close();
downstream.onclose = () => void close();
process.stdin.once('end', () => void close());

try {
  await upstream.connect(transport, { timeout: 6000 });
} catch (error) {
  await close();
  throw error;
}
let active: string | undefined;
let tail: Promise<unknown> = Promise.resolve();

downstream.setRequestHandler(ListToolsRequestSchema, async ({ params }, { signal }) => {
  const page = await upstream.listTools(params, { signal, timeout: 6000 });
  return { ...page, tools: page.tools.filter(({ name }) => lifecycle.has(name)) };
});

downstream.setRequestHandler(CallToolRequestSchema, ({ params }, { signal }) => {
  const call = tail.then(async () => {
    signal.throwIfAborted();
    const { name, arguments: args = {} } = params;
    if (!lifecycle.has(name)) return reject('This tool is not exposed by atelier-openwiki.');
    const forward = async (tool: string, input: Record<string, unknown>) =>
      CallToolResultSchema.parse(
        await upstream.callTool({ name: tool, arguments: input }, CallToolResultSchema, {
          signal,
          timeout: 28_000,
        }),
      );
    if (name === begin) {
      if (typeof args.root !== 'string' || !isAbsolute(args.root) || resolve(args.root) !== root) {
        return reject('OpenWiki root must be the Git top-level of this atelier session.');
      }
      const result = await forward(name, { ...args, root });
      active = activeRunId(result);
      return result;
    }
    if (typeof args.runId !== 'string' || !args.runId || 'root' in args) {
      return reject('Use the runId from openwiki_begin; do not pass root to follow-up tools.');
    }
    if (active !== args.runId) {
      const saved = await readSavedRun(root).catch(() => undefined);
      if (!saved || saved.runId !== args.runId) {
        return reject(
          'No matching saved OpenWiki run in this checkout. Call openwiki_begin first.',
        );
      }
      signal.throwIfAborted();
      const result = await forward(begin, { root, mode: saved.mode, language: saved.language });
      active = activeRunId(result);
      if (result.isError) return result;
      if (active !== args.runId) {
        return reject('OpenWiki did not restore the requested run. Call openwiki_begin again.');
      }
    }
    signal.throwIfAborted();
    const result = await forward(name, args);
    // No automatic follow-up retry: OpenWiki may have progressed before a call failed.
    if (name === finish || result.isError) active = undefined;
    return result;
  });
  tail = call.catch(() => undefined);
  return call;
});

await downstream.connect(new StdioServerTransport());
