import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { sendModelReply } from './fixtures/subagent-gateway.js';

const model = 'sdk-probe';
const children = ['PROBE_FIRST_CHILD', 'PROBE_SECOND_CHILD', 'PROBE_THIRD_CHILD'];

test(
  'bundled SDK starts three same-batch foreground requests before release and attributes each MCP call',
  { timeout: 45_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atelier-subagent-sdk-'));
    const calls = new Map<string, string>();
    const agents = new Set<string>();
    const requestFailures: string[] = [];
    const starts: string[] = [];
    const reports: string[] = [];
    let startsBeforeRelease: string[] = [];
    let releaseRequests: () => void = () => {};
    const requestsReady = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const gateway = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const x of req) chunks.push(Buffer.from(x));
        const request = JSON.parse(Buffer.concat(chunks).toString());
        const text = JSON.stringify(request.messages);
        const child = children.find((name) => text.includes(name) && !text.includes('PROBE_MAIN'));
        if (child) {
          if (!text.includes(`toolu_${child}`)) {
            starts.push(child);
            if (starts.length === 1)
              releaseTimer = setTimeout(() => {
                requestFailures.push('Three foreground requests did not overlap before release');
                startsBeforeRelease = [...starts];
                releaseRequests();
              }, 4000);
            if (starts.length === children.length) {
              clearTimeout(releaseTimer);
              startsBeforeRelease = [...starts];
              releaseRequests();
            }
            await requestsReady;
            sendModelReply(res, model, [
              { name: 'mcp__probe__test', id: `toolu_${child}`, input: { data: 'same' } },
            ]);
          } else {
            reports.push(child);
            sendModelReply(res, model, `REPORTED_${child}`);
          }
        } else if (children.every((name) => text.includes(`REPORTED_${name}`))) {
          sendModelReply(res, model, 'MAIN_COLLECTED');
        } else if (text.includes('toolu_spawn_')) {
          requestFailures.push(`Parent did not get all three reports: ${text.slice(-1400)}`);
          sendModelReply(res, model, 'MAIN_FAILED');
        } else {
          assert.ok(JSON.stringify(request.tools).includes('Agent'));
          sendModelReply(
            res,
            model,
            children.map((prompt, i) => ({
              name: 'Agent',
              id: `toolu_spawn_${i}`,
              input: {
                description: `Inspect sample ${i}`,
                prompt,
                subagent_type: 'tester',
                run_in_background: false,
              },
            })),
          );
        }
      } catch (error) {
        requestFailures.push(String(error));
        res.writeHead(400).end();
      }
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const address = gateway.address();
    assert.ok(address && typeof address === 'object');
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 25_000);
    const input = async function* (): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        message: { role: 'user', content: 'PROBE_MAIN' },
        parent_tool_use_id: null,
        session_id: '',
      };
      await new Promise<void>((resolve) =>
        abortController.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    };
    const probeTool = tool(
      'test',
      'A synthetic, inert tool',
      { data: z.string(), atelierTicket: z.string().optional() },
      async (args) => {
        assert.ok(args.atelierTicket);
        assert.ok(agents.has(args.atelierTicket));
        calls.set(args.atelierTicket, args.data);
        return { content: [{ type: 'text', text: 'PROBE_TOOL_COMPLETE' }] };
      },
    );
    const sdk = query({
      prompt: input(),
      options: {
        cwd: dir,
        model,
        settingSources: [],
        tools: ['Agent'],
        allowedTools: [],
        agents: {
          tester: {
            description: 'Inspect a synthetic sample',
            prompt: 'You test a fixture',
            tools: ['mcp__probe__test'],
            model: 'inherit',
          },
        },
        env: {
          PATH: process.env.PATH,
          ANTHROPIC_AUTH_TOKEN: 'probe',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          CLAUDE_CONFIG_DIR: join(dir, 'sdk'),
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
          CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
        },
        abortController,
        persistSession: false,
        strictMcpConfig: true,
        mcpServers: {
          probe: createSdkMcpServer({ name: 'probe', tools: [probeTool], alwaysLoad: true }),
        },
        hooks: {
          PreToolUse: [
            {
              onFailure: 'block',
              hooks: [
                async (event) => {
                  if (event.hook_event_name !== 'PreToolUse') return {};
                  if (event.tool_name === 'Agent' && !event.agent_id)
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'allow',
                      },
                    };
                  if (event.tool_name === 'mcp__probe__test' && event.agent_id) {
                    agents.add(event.agent_id);
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'allow',
                        updatedInput: { data: 'same', atelierTicket: event.agent_id },
                      },
                    };
                  }
                  return {
                    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
                  };
                },
              ],
            },
          ],
        },
      },
    });
    try {
      let final: string | undefined;
      const started = new Map<string, string | undefined>();
      for await (const message of sdk) {
        if (message.type === 'system' && message.subtype === 'task_started')
          started.set(message.task_id, message.tool_use_id);
        if (message.type === 'result') {
          final = message.subtype === 'success' ? message.result : message.errors.join('\n');
          break;
        }
      }
      assert.deepEqual(requestFailures, []);
      assert.deepEqual(startsBeforeRelease.sort(), [...children].sort());
      assert.equal(calls.size, 3);
      assert.deepEqual(
        [...started.keys()].filter((id) => !calls.has(id)),
        [],
      );
      assert.deepEqual(
        [...started.values()].sort(),
        children.map((_, index) => `toolu_spawn_${index}`),
      );
      assert.deepEqual(reports.sort(), [...children].sort());
      assert.equal(final, 'MAIN_COLLECTED');
    } finally {
      clearTimeout(releaseTimer);
      releaseRequests();
      clearTimeout(timeout);
      abortController.abort();
      sdk.close();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
