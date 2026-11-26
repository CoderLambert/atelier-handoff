/**
 * @file 验证内置 RTK 插件在锁定 SDK 中的权限边界与原生 Bash 生命周期。
 * @implementation 用隔离仓库、回环模型和可控包装器核对两份命令的规则、宿主 opt-in、后台移交与真实回执；显式提供资源时另验固定摘要的 RTK OSS。
 * @updated 2026-11-26T12:00:00+08:00
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  query,
  type PostToolUseFailureHookInput,
  type PostToolUseHookInput,
  type Query,
  type SDKResultMessage,
  type SDKTaskNotificationMessage,
  type SDKTaskStartedMessage,
  type SDKUserMessage,
  type Settings,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  builtinRtkAvailable,
  mountBuiltinRtkPlugin,
  publishBuiltinRtkPlan,
} from '../server/builtin-rtk.js';
import { nativeSdkOptions } from '../server/native-harness.js';
import { rtkLauncher, rtkRelease } from '../shared/builtin-rtk.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

const execute = promisify(execFile);
const model = 'fixture-builtin-rtk';
const toolId = 'toolu_builtin_rtk';
const originalInput = {
  command: 'git status',
  description: 'Inspect the isolated fixture repository',
  timeout: 30_000,
};
const requestSchema = z.object({
  messages: z.array(z.object({ content: z.unknown() })),
});
const receiptSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.literal(toolId),
  content: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))]),
  is_error: z.boolean().optional(),
});
type Receipt = z.infer<typeof receiptSchema>;
type Policy = { target: 'original' | 'actual'; rule: 'ask' | 'deny'; source?: 'flag' | 'managed' };
type Scenario = {
  disabled?: boolean;
  host?: 'allow' | 'deny' | 'no-opt-in' | 'changed-input';
  policy?: Policy;
  approve?: boolean;
  hold?: boolean;
  background?: boolean;
  timeout?: number;
  repository?: 'missing';
  exit?: number;
  launcher?: string;
};
type Observation = {
  before: unknown[];
  after: PostToolUseHookInput[];
  failures: PostToolUseFailureHookInput[];
  prompts: unknown[];
  receipts: Receipt[];
  sdkReceipts: Receipt[];
  results: SDKResultMessage[];
  starts: SDKTaskStartedMessage[];
  terminals: SDKTaskNotificationMessage[];
  stderr: string[];
  calls: string[];
  actual: string;
};
type Control = {
  sdk: Query;
  observed: Observation;
  rtkHome: string;
  waitFor: (predicate: () => boolean) => Promise<void>;
  release: () => Promise<void>;
  started: () => Promise<void>;
};

function receipts(content: unknown): Receipt[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    const parsed = receiptSchema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
}

function receiptText(receipt: Receipt): string {
  return typeof receipt.content === 'string'
    ? receipt.content
    : receipt.content.map(({ text }) => text).join('\n');
}

// The wrapper accepts exactly the production mapper's original argument vector.
// Its marker proves a launch occurred; policy failures must leave it absent.
const inertLauncher = `#!/bin/sh
[ "$#" = 2 ] && [ "$1" = git ] && [ "$2" = status ] || exit 64
printf '%s\\n' "$*" >> "$RTK_PROBE_MARKER"
printf '%s\\n' 'wrapper-start'
if [ "\${RTK_PROBE_HOLD-}" = 1 ]; then
  while ! test -f "$RTK_PROBE_RELEASE"; do /usr/bin/sleep 0.02; done
fi
if [ "\${RTK_PROBE_EXIT-0}" != 0 ]; then
  printf '%s\\n' 'wrapper-failure' >&2
  exit "$RTK_PROBE_EXIT"
fi
exec /usr/bin/git status --short
`;

async function sdkScenario(
  scenario: Scenario,
  control?: (fixture: Control) => Promise<void>,
): Promise<Observation> {
  const root = await mkdtemp(join(tmpdir(), 'atelier-builtin-rtk-sdk-'));
  const repo = join(root, 'repo');
  const marker = join(root, 'wrapper-calls');
  const releaseFile = join(root, 'release');
  const toolInput = {
    ...originalInput,
    timeout: scenario.timeout ?? originalInput.timeout,
    ...(scenario.background ? { run_in_background: true } : {}),
  };
  const launcher = scenario.launcher ?? join(root, "bundled tools' fixture", 'rtk');
  const actual = "'" + launcher.replaceAll("'", "'\\''") + "' " + originalInput.command;
  const observed: Observation = {
    before: [],
    after: [],
    failures: [],
    prompts: [],
    receipts: [],
    sdkReceipts: [],
    results: [],
    starts: [],
    terminals: [],
    stderr: [],
    calls: [],
    actual,
  };
  const abortController = new AbortController();
  const ended = new Promise<void>((resolve) => {
    abortController.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: 'Inspect fixture status once.' },
      session_id: '',
      parent_tool_use_id: null,
    };
    await ended;
  }
  let issued = 0;
  let streamFailure: unknown;
  const gateway = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const parsed = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (issued === 0) {
        issued += 1;
        sendModelReply(response, model, [{ id: toolId, name: 'Bash', input: toolInput }]);
      } else {
        // Read the next model request rather than infer its receipt from hook output.
        observed.receipts = parsed.messages.flatMap(({ content }) => receipts(content));
        sendModelReply(response, model, 'Fixture finished.');
      }
    } catch (error) {
      streamFailure = error;
      response.writeHead(500).end();
    }
  });
  let sdk: Query | undefined;
  let consuming: Promise<void> | undefined;
  let closing = false;
  try {
    await mkdir(repo);
    if (scenario.repository !== 'missing') {
      await execute('/usr/bin/git', ['init', '--quiet'], {
        cwd: repo,
        env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
      });
    }
    await writeFile(join(repo, 'fixture-file'), 'fixture content\n');
    if (!scenario.launcher) {
      await mkdir(join(root, "bundled tools' fixture"));
      await writeFile(launcher, inertLauncher, { mode: 0o700 });
    }
    const plugin = await mountBuiltinRtkPlugin(root);
    const target = scenario.policy?.target === 'actual' ? actual : originalInput.command;
    const settings: Settings | undefined = scenario.policy
      ? { permissions: { [scenario.policy.rule]: [`Bash(${target})`] } }
      : undefined;
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const address = gateway.address();
    assert.ok(address && typeof address !== 'string');
    sdk = query({
      prompt: input(),
      options: {
        ...nativeSdkOptions(),
        cwd: repo,
        model,
        tools: ['Bash'],
        settingSources: [],
        persistSession: false,
        strictMcpConfig: true,
        abortController,
        settings: scenario.policy?.source === 'flag' ? settings : undefined,
        managedSettings: scenario.policy?.source === 'flag' ? undefined : settings,
        plugins: scenario.disabled ? [] : [{ type: 'local', path: plugin }],
        stderr: (text) => observed.stderr.push(text),
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          SHELL: '/bin/bash',
          LANG: 'C',
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_DATA_HOME: join(root, 'data'),
          XDG_CACHE_HOME: join(root, 'cache'),
          TMPDIR: root,
          CLAUDE_CONFIG_DIR: join(root, 'sdk'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          ANTHROPIC_AUTH_TOKEN: 'fixture',
          GIT_CONFIG_NOSYSTEM: '1',
          ATELIER_RTK_HOME: join(root, 'rtk-data'),
          RTK_PROBE_MARKER: marker,
          RTK_PROBE_RELEASE: releaseFile,
          RTK_PROBE_HOLD: scenario.hold ? '1' : '0',
          RTK_PROBE_EXIT: String(scenario.exit ?? 0),
        },
        canUseTool: async (_tool, args) => {
          observed.prompts.push(args.command);
          return scenario.approve
            ? { behavior: 'allow', updatedInput: args }
            : { behavior: 'deny', message: 'Fixture refused approval' };
        },
        hooks: {
          PreToolUse: [
            {
              onFailure: 'block',
              hooks: [
                async (event) => {
                  if (event.hook_event_name !== 'PreToolUse') return {};
                  observed.before.push(event.tool_input);
                  const original = z.record(z.string(), z.unknown()).parse(event.tool_input);
                  if (scenario.host !== 'deny' && scenario.host !== 'no-opt-in') {
                    assert.ok(event.tool_use_id);
                    assert.equal(
                      await publishBuiltinRtkPlan(plugin, event.tool_use_id, {
                        hook: 'builtin-rtk',
                        originalCommand: originalInput.command,
                        executedCommand: actual,
                      }),
                      true,
                    );
                  }
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: scenario.host === 'deny' ? 'deny' : 'allow',
                      permissionDecisionReason: 'Runtime scope check',
                      // The real host opts in only after its existing scope checks allow
                      // the unchanged original. Controlled/subagent calls omit this field.
                      ...(scenario.host === 'deny' || scenario.host === 'no-opt-in'
                        ? {}
                        : {
                            updatedInput:
                              scenario.host === 'changed-input'
                                ? { ...original, description: 'Host-owned description' }
                                : original,
                          }),
                    },
                  };
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                async (event) => {
                  if (event.hook_event_name === 'PostToolUse') observed.after.push(event);
                  return {};
                },
              ],
            },
          ],
          PostToolUseFailure: [
            {
              hooks: [
                async (event) => {
                  if (event.hook_event_name === 'PostToolUseFailure') observed.failures.push(event);
                  return {};
                },
              ],
            },
          ],
        },
      },
    });
    const connection = sdk;
    consuming = (async () => {
      for await (const message of connection) {
        if (message.type === 'result') observed.results.push(message);
        if (message.type === 'user')
          observed.sdkReceipts.push(...receipts(message.message.content));
        if (message.type === 'system' && message.subtype === 'task_started')
          observed.starts.push(message);
        if (message.type === 'system' && message.subtype === 'task_notification')
          observed.terminals.push(message);
      }
    })().catch((error: unknown) => {
      if (!closing) streamFailure = error;
    });
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 15_000;
      while (!predicate()) {
        if (streamFailure) throw streamFailure;
        assert.ok(Date.now() < deadline, `SDK scenario timed out: ${JSON.stringify(observed)}`);
        await delay(20);
      }
    };
    if (control) {
      await control({
        sdk: connection,
        observed,
        rtkHome: join(root, 'rtk-data'),
        waitFor,
        release: () => writeFile(releaseFile, ''),
        started: async () => {
          await waitFor(() => observed.starts.some((task) => task.tool_use_id === toolId));
          // A task may be registered before its child actually starts.
          const deadline = Date.now() + 5000;
          while (!(await readFile(marker, 'utf8').catch(() => ''))) {
            assert.ok(Date.now() < deadline, 'Wrapper did not start');
            await delay(20);
          }
        },
      });
    }
    await waitFor(() => observed.results.length > 0);
    if (streamFailure) throw streamFailure;
    assert.equal(issued, 1, 'The fixture requests exactly one native Bash dispatch');
    observed.calls = (await readFile(marker, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    return observed;
  } finally {
    closing = true;
    abortController.abort();
    sdk?.close();
    await consuming;
    gateway.closeAllConnections();
    if (gateway.listening) await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

function onlyReceipt(observed: Observation): Receipt {
  assert.equal(observed.receipts.length, 1, 'The model receives exactly one original tool result');
  const receipt = observed.receipts[0];
  assert.ok(receipt);
  return receipt;
}

function assertOriginal(observed: Observation): void {
  assert.deepEqual(observed.calls, []);
  assert.equal(observed.after.length, 1);
  assert.deepEqual(observed.after[0]?.tool_input, originalInput);
  const receipt = onlyReceipt(observed);
  assert.notEqual(receipt.is_error, true);
  assert.match(receiptText(receipt), /fixture-file/u);
}

function assertWrapped(observed: Observation): void {
  assert.deepEqual(observed.calls, ['git status']);
  assert.equal(observed.after.length, 1);
  assert.deepEqual(observed.after[0]?.tool_input, { ...originalInput, command: observed.actual });
  const receipt = onlyReceipt(observed);
  assert.notEqual(receipt.is_error, true);
  assert.match(receiptText(receipt), /fixture-file/u);
}

test(
  'production RTK plugin preserves both native command permission checks',
  {
    skip: process.platform !== 'linux',
    timeout: 180_000,
  },
  async (context) => {
    context.diagnostic(
      'real SDK 0.3.332; production plugin; loopback model; inert launcher; paid requests=0',
    );
    const cases: {
      name: string;
      scenario: Scenario;
      outcome: 'original' | 'wrapped' | 'denied';
      prompt?: 'original' | 'actual';
    }[] = [
      {
        name: 'enabled dispatches once with the exact original arguments',
        scenario: {},
        outcome: 'wrapped',
      },
      { name: 'disabled keeps native Bash', scenario: { disabled: true }, outcome: 'original' },
      {
        name: 'runtime denial happens before a wrapper can launch',
        scenario: { host: 'deny' },
        outcome: 'denied',
      },
      {
        name: 'managed original deny',
        scenario: { policy: { target: 'original', rule: 'deny' } },
        outcome: 'denied',
      },
      {
        name: 'managed original ask declined',
        scenario: { policy: { target: 'original', rule: 'ask' } },
        outcome: 'denied',
        prompt: 'original',
      },
      {
        name: 'managed original ask approved stays native',
        scenario: { policy: { target: 'original', rule: 'ask' }, approve: true },
        outcome: 'original',
        prompt: 'original',
      },
      {
        name: 'sec-default disables the plugin for managed wrapper deny',
        scenario: { policy: { target: 'actual', rule: 'deny' } },
        outcome: 'original',
      },
      {
        name: 'sec-default disables the plugin for managed wrapper ask',
        scenario: { policy: { target: 'actual', rule: 'ask' } },
        outcome: 'original',
      },
      {
        name: 'flag original deny',
        scenario: { policy: { target: 'original', rule: 'deny', source: 'flag' } },
        outcome: 'denied',
      },
      {
        name: 'flag original ask declined',
        scenario: { policy: { target: 'original', rule: 'ask', source: 'flag' } },
        outcome: 'denied',
        prompt: 'original',
      },
      {
        name: 'flag wrapper deny',
        scenario: { policy: { target: 'actual', rule: 'deny', source: 'flag' } },
        outcome: 'denied',
      },
      {
        name: 'flag wrapper ask declined',
        scenario: { policy: { target: 'actual', rule: 'ask', source: 'flag' } },
        outcome: 'denied',
        prompt: 'actual',
      },
      {
        name: 'flag wrapper ask approved dispatches once',
        scenario: { policy: { target: 'actual', rule: 'ask', source: 'flag' }, approve: true },
        outcome: 'wrapped',
        prompt: 'actual',
      },
      {
        name: 'controlled or subagent host without opt-in stays native',
        scenario: { host: 'no-opt-in' },
        outcome: 'original',
      },
    ];
    for (const entry of cases)
      await context.test(entry.name, async () => {
        const observed = await sdkScenario(entry.scenario);
        assert.deepEqual(observed.before, [originalInput]);
        assert.equal(observed.results[0]?.subtype, 'success', JSON.stringify(observed.results));
        assert.deepEqual(
          observed.prompts,
          entry.prompt ? [entry.prompt === 'actual' ? observed.actual : originalInput.command] : [],
        );
        if (entry.outcome === 'wrapped') assertWrapped(observed);
        else if (entry.outcome === 'original') assertOriginal(observed);
        else {
          assert.deepEqual(observed.calls, []);
          assert.deepEqual(observed.after, []);
          assert.equal(onlyReceipt(observed).is_error, true);
        }
      });
    await context.test('host-owned argument changes are preserved without RTK', async () => {
      const observed = await sdkScenario({ host: 'changed-input' });
      assert.deepEqual(observed.calls, []);
      assert.equal(observed.after.length, 1);
      assert.deepEqual(observed.after[0]?.tool_input, {
        ...originalInput,
        description: 'Host-owned description',
      });
      assert.match(receiptText(onlyReceipt(observed)), /fixture-file/u);
    });
  },
);

test(
  'RTK keeps native Bash failure, background control and cancellation receipts',
  {
    skip: process.platform !== 'linux',
    timeout: 90_000,
  },
  async (context) => {
    await context.test('nonzero execution is reported once and never retried', async () => {
      const observed = await sdkScenario({ exit: 7 });
      assert.deepEqual(observed.calls, ['git status']);
      assert.deepEqual(observed.after, []);
      assert.equal(observed.failures.length, 1);
      assert.deepEqual(observed.failures[0]?.tool_input, {
        ...originalInput,
        command: observed.actual,
      });
      const receipt = onlyReceipt(observed);
      assert.equal(receipt.is_error, true);
      assert.match(receiptText(receipt), /Exit code 7/u);
      assert.match(receiptText(receipt), /wrapper-failure/u);
    });
    for (const mode of ['control', 'input', 'timeout'] as const) {
      await context.test(
        `background handoff by ${mode} retains the original tool identity and output`,
        async () => {
          const timeout = mode === 'timeout' ? 1200 : originalInput.timeout;
          const observed = await sdkScenario(
            { hold: true, background: mode === 'input', timeout },
            async ({ sdk, observed, started, waitFor, release }) => {
              await started();
              if (mode === 'control') assert.equal(await sdk.backgroundTasks(toolId), true);
              await waitFor(() => observed.receipts.length === 1 && observed.after.length === 1);
              const response = z
                .object({ backgroundTaskId: z.string() })
                .parse(observed.after[0]?.tool_response);
              assert.match(receiptText(onlyReceipt(observed)), /background/iu);
              await release();
              await waitFor(() =>
                observed.terminals.some((task) => task.task_id === response.backgroundTaskId),
              );
              const task = observed.terminals.find(
                (task) => task.task_id === response.backgroundTaskId,
              );
              assert.ok(task);
              assert.equal(task.status, 'completed');
              assert.equal(task.tool_use_id, toolId);
              assert.match(await readFile(task.output_file, 'utf8'), /fixture-file/u);
              assert.equal(await sdk.backgroundTasks(toolId), false);
            },
          );
          assert.deepEqual(observed.calls, ['git status']);
          assert.equal(observed.starts[0]?.is_backgrounded, mode !== 'control');
          assert.deepEqual(observed.after[0]?.tool_input, {
            ...originalInput,
            command: observed.actual,
            timeout,
            ...(mode === 'input' ? { run_in_background: true } : {}),
          });
        },
      );
    }
    await context.test(
      'stopping a background command produces a stopped task receipt',
      async () => {
        const observed = await sdkScenario(
          { hold: true },
          async ({ sdk, observed, started, waitFor }) => {
            await started();
            assert.equal(await sdk.backgroundTasks(toolId), true);
            await waitFor(() => observed.after.length === 1);
            const response = z
              .object({ backgroundTaskId: z.string() })
              .parse(observed.after[0]?.tool_response);
            await sdk.stopTask(response.backgroundTaskId);
            await waitFor(() =>
              observed.terminals.some((task) => task.task_id === response.backgroundTaskId),
            );
            const task = observed.terminals.find(
              (task) => task.task_id === response.backgroundTaskId,
            );
            assert.equal(task?.status, 'stopped');
            assert.equal(task?.tool_use_id, toolId);
          },
        );
        assert.deepEqual(observed.calls, ['git status']);
      },
    );
    await context.test(
      'interrupting a foreground command retains a cancelled original tool receipt',
      async () => {
        const observed = await sdkScenario(
          { hold: true },
          async ({ sdk, observed, started, waitFor }) => {
            await started();
            await sdk.interrupt();
            await waitFor(() => observed.sdkReceipts.length > 0 && observed.terminals.length > 0);
          },
        );
        assert.deepEqual(observed.calls, ['git status']);
        assert.deepEqual(observed.after, []);
        // Native interruption reports through the SDK receipt and task notification,
        // without running PostToolUseFailure or another model request.
        assert.deepEqual(observed.failures, []);
        assert.deepEqual(observed.receipts, []);
        assert.equal(observed.terminals[0]?.status, 'stopped');
        assert.equal(observed.terminals[0]?.tool_use_id, toolId);
        assert.equal(observed.sdkReceipts.length, 1);
        const receipt = observed.sdkReceipts[0];
        assert.ok(receipt);
        assert.equal(receipt.is_error, true);
        assert.match(receiptText(receipt), /stopped while running/u);
      },
    );
  },
);

// Opt in with ATELIER_TEST_RTK_BINARY=/absolute/path/to/the/pinned/rtk.
// Never search PATH, execute an unverified binary, or write the user's RTK data.
test(
  'verified RTK OSS runs through the production plugin with isolated application data',
  {
    skip:
      process.platform !== 'linux' ||
      process.arch !== 'x64' ||
      !process.env.ATELIER_TEST_RTK_BINARY,
    timeout: 30_000,
  },
  async (context) => {
    const binary = process.env.ATELIER_TEST_RTK_BINARY;
    assert.ok(binary);
    assert.ok((await lstat(binary)).isFile());
    assert.equal(
      createHash('sha256')
        .update(await readFile(binary))
        .digest('hex'),
      rtkRelease.binarySha256,
    );
    const root = await mkdtemp(join(tmpdir(), 'atelier-real-rtk-'));
    try {
      const resource = join(root, 'resource with spaces', 'rtk');
      const launcher = join(root, 'resource with spaces', 'bin', 'rtk');
      await mkdir(join(root, 'resource with spaces', 'bin'), { recursive: true });
      await copyFile(binary, resource);
      await writeFile(launcher, rtkLauncher, { mode: 0o700 });
      assert.equal(await builtinRtkAvailable(resource), true);
      const observed = await sdkScenario({ launcher }, async ({ observed, waitFor, rtkHome }) => {
        await waitFor(() => observed.results.length > 0);
        assert.ok((await lstat(join(rtkHome, 'tracking.sqlite'))).isFile());
      });
      assert.equal(observed.after.length, 1);
      assert.deepEqual(observed.after[0]?.tool_input, {
        ...originalInput,
        command: observed.actual,
      });
      const receipt = onlyReceipt(observed);
      assert.notEqual(receipt.is_error, true);
      assert.match(receiptText(receipt), /fixture-file/u);
      const failed = await sdkScenario({ launcher, repository: 'missing' });
      assert.deepEqual(failed.before, [originalInput]);
      assert.deepEqual(failed.after, []);
      assert.equal(failed.failures.length, 1);
      assert.deepEqual(failed.failures[0]?.tool_input, {
        ...originalInput,
        command: failed.actual,
      });
      const failureReceipt = onlyReceipt(failed);
      assert.equal(failureReceipt.is_error, true);
      assert.match(receiptText(failureReceipt), /Exit code 128/u);
      assert.match(receiptText(failureReceipt), /not a git repository/iu);
      context.diagnostic(
        `real SDK 0.3.332; verified RTK OSS ${rtkRelease.version}; loopback model; paid requests=0`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
