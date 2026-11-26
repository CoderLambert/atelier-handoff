/**
 * @file 验证运行中的 RTK 设置变化与真实 SDK 执行回执。
 * @implementation 用摘要锁定的 RTK、隔离 HTTP 工作台和回环模型，在同一轮 Bash 之间切换项目/全局设置并核对持久轨迹及不适用场景。
 * @updated 2026-11-26T01:47:41+08:00
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createApp } from '../server/app.js';
import { builtinRtkAvailable } from '../server/builtin-rtk.js';
import { rtkLauncher, rtkRelease } from '../shared/builtin-rtk.js';
import { desktopPairingHeader } from '../shared/desktop-host.js';
import { rtkSettingsViewSchema, type RtkSettingsPatch } from '../shared/rtk-settings.js';
import type { Run, SendSessionMessageResult, ToolCall } from '../shared/types.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

const execute = promisify(execFile);
const resultSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))]),
});
type Receipt = z.infer<typeof resultSchema>;
function text(receipt: Receipt) {
  return typeof receipt.content === 'string'
    ? receipt.content
    : receipt.content.map(({ text }) => text).join('\n');
}
function deferred() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

// Explicit opt-in never discovers a system RTK or executes an unverified resource.
test(
  'active runtime rechecks project/global RTK settings between native Bash calls and persists confirmed traces',
  {
    skip:
      process.platform !== 'linux' ||
      process.arch !== 'x64' ||
      !process.env.ATELIER_TEST_RTK_BINARY,
    timeout: 60_000,
  },
  async (context) => {
    const supplied = process.env.ATELIER_TEST_RTK_BINARY;
    assert.ok(supplied);
    assert.ok((await lstat(supplied)).isFile());
    assert.equal(
      createHash('sha256')
        .update(await readFile(supplied))
        .digest('hex'),
      rtkRelease.binarySha256,
    );
    const directory = await mkdtemp(join(tmpdir(), 'atelier-rtk-settings-sdk-'));
    const project = join(directory, 'project');
    const home = join(directory, 'home');
    const data = join(directory, 'data');
    const resource = join(directory, "pinned resources' folder", 'rtk', 'rtk');
    const launcher = join(directory, "pinned resources' folder", 'rtk', 'bin', 'rtk');
    const prefix = "'" + launcher.replaceAll("'", "'\\''") + "'";
    const model = 'fixture-rtk-settings-runtime';
    const nativeMarker = 'ACTIVE_RTK_SETTINGS_NATIVE_FIXTURE';
    const controlledMarker = 'ACTIVE_RTK_SETTINGS_CONTROLLED_FIXTURE';
    const branchQuery = 'git fetch --all && git branch -a -vv && git remote';
    const counts = 'git rev-list --left-right --count HEAD...origin/right';
    const comparison = 'git log --oneline --left-right HEAD...origin/right';
    const comparisonQuery = counts + ' && ' + comparison + ' && git status --short';
    const commands = [
      'git status',
      'git status',
      'git status',
      'git status',
      'git status --short',
      'ls -la && git status && printf RTK_COMPOUND_SUFFIX',
      'npm test -- --probe',
      branchQuery,
      comparisonQuery,
      'git status --porcelain=v2',
    ];
    const gates = commands.map(() => deferred());
    const held = new Set<number>();
    const receipts = new Map<string, Receipt>();
    let nativeRequests = 0;
    let controlledRequests = 0;
    let gatewayError: unknown;
    const requestSchema = z.object({ messages: z.array(z.object({ content: z.unknown() })) });
    const gateway = createServer(async (request, response) => {
      try {
        if (request.method !== 'POST') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ data: [{ model, id: model }] }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const wire = Buffer.concat(chunks).toString('utf8');
        const payload = requestSchema.parse(JSON.parse(wire));
        for (const message of payload.messages) {
          if (!Array.isArray(message.content)) continue;
          for (const block of message.content) {
            const receipt = resultSchema.safeParse(block);
            if (receipt.success) receipts.set(receipt.data.tool_use_id, receipt.data);
          }
        }
        if (wire.includes(nativeMarker)) {
          const index = nativeRequests++;
          if (index >= commands.length)
            return sendModelReply(response, model, 'Native fixture finished.');
          if (index > 0) {
            held.add(index);
            await gates[index]?.ready;
          }
          const command = commands[index];
          assert.ok(command);
          sendModelReply(response, model, [
            {
              id: `toolu_rtk_settings_${index}`,
              name: 'Bash',
              input: {
                command,
                description: 'Inspect isolated RTK settings fixture',
                timeout: 6000,
              },
            },
          ]);
        } else if (wire.includes(controlledMarker)) {
          if (controlledRequests++ === 0)
            sendModelReply(response, model, [
              {
                id: 'toolu_rtk_settings_controlled',
                name: 'Bash',
                input: {
                  command: 'git status',
                  description: 'Blocked native tool in controlled mode',
                },
              },
            ]);
          else sendModelReply(response, model, 'Controlled fixture finished.');
        } else throw new Error('Unexpected loopback model request');
      } catch (error) {
        gatewayError = error;
        response.writeHead(500).end();
      }
    });
    const oldEnvironment = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries({
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CACHE_HOME: join(home, 'cache'),
      ATELIER_GATEWAY_TOKEN: 'rtk-runtime-fixture',
      LANG: 'C',
      LC_ALL: 'C',
    })) {
      oldEnvironment.set(key, process.env[key]);
      process.env[key] = value;
    }
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    let base = '';
    const pairing = 'isolated-rtk-settings';
    const headers: Record<string, string> = {
      [desktopPairingHeader]: pairing,
      'content-type': 'application/json',
    };
    async function request<T>(
      path: string,
      method = 'GET',
      body?: unknown,
      status = 200,
    ): Promise<T> {
      const response = await fetch(base + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value: unknown = await response.json();
      assert.equal(response.status, status, JSON.stringify(value));
      // The test asserts every response field it consumes; production DTO parsing remains unchanged.
      return value as T;
    }
    async function open() {
      app = await createApp({
        root: fileURLToPath(new URL('../', import.meta.url)),
        data,
        nativeExecution: true,
        desktopPairing: pairing,
        rtkBinary: resource,
      });
      app.server.listen(0, '127.0.0.1');
      await once(app.server, 'listening');
      const address = app.server.address();
      assert.ok(address && typeof address === 'object');
      base = `http://127.0.0.1:${address.port}`;
      headers['x-atelier-token'] = (
        await request<{ csrfToken: string }>('/api/bootstrap')
      ).csrfToken;
    }
    async function wait<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (gatewayError) throw gatewayError;
        const value = await read();
        if (value !== undefined) return value;
        await delay(30);
      }
      throw new Error('Timed out observing ' + label);
    }
    const trace = (runId: string) => request<{ run: Run; tools: ToolCall[] }>(`/api/runs/${runId}`);
    try {
      await Promise.all([
        mkdir(project),
        mkdir(home),
        mkdir(join(resource, '..', 'bin'), { recursive: true }),
      ]);
      await copyFile(supplied, resource);
      await chmod(resource, 0o700);
      await writeFile(launcher, rtkLauncher, { mode: 0o700 });
      assert.equal(await builtinRtkAvailable(resource), true);
      // Git is confined to this test-owned repository; no workspace Git commands are issued.
      const git = (...args: string[]) =>
        execute('/usr/bin/git', args, {
          cwd: project,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: home,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
          },
        });
      await git('init', '--quiet', '--initial-branch=main');
      await git('config', 'user.name', 'Fixture');
      await git('config', 'user.email', 'fixture@example.invalid');
      await git('commit', '-q', '--allow-empty', '-m', 'COMMON_BASE');
      await git('switch', '-q', '-c', 'right');
      await git('switch', '-q', '-c', 'side');
      await git('commit', '-q', '--allow-empty', '-m', 'REMOTE_SIDE');
      await git('switch', '-q', 'right');
      await git('merge', '-q', '--no-ff', 'side', '-m', 'REMOTE_ONLY_MERGE');
      await git('switch', '-q', 'main');
      await git('commit', '-q', '--allow-empty', '-m', 'LOCAL_ONLY_COMMIT');
      await git('remote', 'add', 'origin', '.');
      await git('fetch', '-q', 'origin');
      await git('remote', 'set-head', 'origin', 'right');
      await writeFile(join(project, 'fixture-untracked.txt'), 'synthetic fixture\n');
      await writeFile(
        join(project, 'package.json'),
        JSON.stringify({
          scripts: { test: 'node fixture-test.cjs' },
        }),
      );
      await writeFile(
        join(project, 'fixture-test.cjs'),
        [
          'const assert = require("node:assert/strict");',
          'assert.deepEqual(process.argv.slice(2), ["--probe"]);',
          'assert.equal(process.env.XDG_CONFIG_HOME, ' +
            JSON.stringify(join(home, 'config')) +
            ');',
          'console.log("RTK_NPM_SCRIPT_REACHED");',
        ].join('\n'),
      );
      gateway.listen(0, '127.0.0.1');
      await once(gateway, 'listening');
      const address = gateway.address();
      assert.ok(address && typeof address === 'object');
      await open();
      await request('/api/config', 'PATCH', {
        gateway: `http://127.0.0.1:${address.port}`,
        model,
        managedGateway: false,
        limitExecution: true,
        maxTurns: 16,
        timeoutMs: 45_000,
      });
      const { project: bound } = await request<{ project: { id: string } }>(
        '/api/projects',
        'POST',
        { path: project },
        201,
      );
      const settings = async (patch?: RtkSettingsPatch) =>
        rtkSettingsViewSchema.parse(
          await request(
            '/api/rtk-settings' + (patch?.type === 'global' ? '' : `?projectId=${bound.id}`),
            patch ? 'PATCH' : 'GET',
            patch,
          ),
        );
      assert.equal((await settings()).available, true);
      assert.equal((await settings()).effectiveEnabled, true);
      async function start(marker: string, executionPreference: 'native-v1' | 'project-v1') {
        const { session } = await request<{ session: { id: string } }>(
          '/api/sessions',
          'POST',
          { projectId: bound.id },
          201,
        );
        const { run } = await request<SendSessionMessageResult>(
          `/api/sessions/${session.id}/messages`,
          'POST',
          {
            text: marker,
            executionPreference,
            mode: 'edit',
            idempotencyKey: randomUUID(),
          },
          202,
        );
        assert.ok(run);
        assert.equal(run.executor, executionPreference);
        return { sessionId: session.id, runId: run.id };
      }
      const native = await start(nativeMarker, 'native-v1');
      async function checkpoint(index: number, wrapped: boolean) {
        await wait(
          async () => (held.has(index) ? true : undefined),
          `model waiting before Bash ${index}`,
        );
        const current = await trace(native.runId);
        assert.equal(
          current.run.status,
          'running',
          'settings change happens inside the same active run',
        );
        assert.equal(current.tools.length, index);
        const call = current.tools.find(({ id }) => id.endsWith(`toolu_rtk_settings_${index - 1}`));
        assert.ok(call);
        assert.equal(call.status, 'succeeded', call.output);
        const command = commands[index - 1];
        assert.ok(command);
        assert.equal(
          z.object({ command: z.string() }).parse(JSON.parse(call.inputSummary)).command,
          command,
        );
        const receipt = receipts.get(`toolu_rtk_settings_${index - 1}`);
        assert.ok(receipt);
        assert.notEqual(receipt.is_error, true, text(receipt));
        assert.match(text(receipt), /fixture-untracked\.txt/u);
        if (wrapped) {
          assert.deepEqual(call.rtk, {
            hook: 'builtin-rtk',
            originalCommand: command,
            executedCommand: prefix + ' ' + command,
          });
          assert.doesNotMatch(
            text(receipt),
            /On branch main/u,
            'model receives real RTK status output',
          );
        } else {
          assert.equal(call.rtk, undefined);
          assert.match(
            text(receipt),
            /On branch main/u,
            'model receives original Git status output',
          );
        }
      }
      await checkpoint(1, true);
      const sdkSession = app?.store.get('sessions', native.sessionId).sdkSessionId;
      assert.ok(sdkSession);
      assert.equal((await settings({ type: 'project', mode: 'off' })).effectiveEnabled, false);
      gates[1]?.release();
      await checkpoint(2, false);
      await settings({ type: 'global', enabled: false });
      assert.equal((await settings({ type: 'project', mode: 'follow' })).effectiveEnabled, false);
      gates[2]?.release();
      await checkpoint(3, false);
      assert.equal((await settings({ type: 'project', mode: 'on' })).effectiveEnabled, true);
      gates[3]?.release();
      await checkpoint(4, true);
      await settings({ type: 'global', enabled: true });
      assert.equal((await settings({ type: 'project', mode: 'follow' })).effectiveEnabled, true);
      gates[4]?.release();
      await wait(async () => (held.has(5) ? true : undefined), 'short-status receipt');
      gates[5]?.release();
      for (const gate of gates.slice(6)) gate.release();
      const finished = await wait(async () => {
        const current = await trace(native.runId);
        return current.run.status === 'completed' ? current : undefined;
      }, 'native run completion');
      assert.equal(finished.tools.length, commands.length);
      assert.equal(nativeRequests, commands.length + 1, 'each model Bash call executes once');
      assert.equal(
        app?.store.get('sessions', native.sessionId).sdkSessionId,
        sdkSession,
        'settings changes do not restart the SDK session',
      );
      const expected = [
        [prefix + ' git status --short', /\?\? fixture-untracked\.txt/u],
        [
          prefix +
            ' --atelier-exec ls -la && ' +
            prefix +
            ' git status && printf RTK_COMPOUND_SUFFIX',
          /RTK_COMPOUND_SUFFIX/u,
        ],
        [prefix + ' --atelier-exec npm run test -- --probe', /RTK_NPM_SCRIPT_REACHED/u],
        [
          prefix + ' git fetch --all && git branch -a -vv && git remote',
          /remotes\/origin\/HEAD\s+-> origin\/right/u,
        ],
        [
          counts + ' && ' + comparison + ' && ' + prefix + ' git status --short',
          /1\t2[\s\S]*>\s+\S+ REMOTE_ONLY_MERGE/u,
        ],
        [undefined, /\? fixture-untracked\.txt/u],
      ] as const;
      for (const [offset, [executedCommand, output]] of expected.entries()) {
        const index = offset + 4;
        const call = finished.tools.find(({ id }) => id.endsWith(`toolu_rtk_settings_${index}`));
        assert.ok(call);
        assert.equal(call.status, 'succeeded', call.output);
        assert.deepEqual(
          call.rtk,
          executedCommand === undefined
            ? undefined
            : {
                hook: 'builtin-rtk',
                originalCommand: commands[index],
                executedCommand,
              },
        );
        const receipt = receipts.get(`toolu_rtk_settings_${index}`);
        assert.ok(receipt);
        assert.match(text(receipt), output);
        if (index === 5) assert.doesNotMatch(text(receipt), /On branch main/u);
      }
      assert.ok(
        (await lstat(join(data, 'rtk', 'tracking.sqlite'))).isFile(),
        'real RTK wrote only the isolated application tracking location',
      );
      const controlled = await start(controlledMarker, 'project-v1');
      const denied = await wait(async () => {
        const current = await trace(controlled.runId);
        return current.run.status === 'completed' ? current : undefined;
      }, 'controlled native tool denial');
      assert.equal(denied.tools.length, 0, 'controlled mode does not dispatch native Bash or RTK');
      assert.ok(
        denied.run.transcript?.notices.some(
          (notice) => notice.kind === 'tool_blocked' && notice.toolName === 'Bash',
        ),
      );
      assert.equal(receipts.get('toolu_rtk_settings_controlled')?.is_error, true);
      const persisted = finished.tools.map(({ id, rtk }) => ({ id, rtk }));
      await app?.close();
      app = undefined;
      await open();
      const restored = await trace(native.runId);
      assert.deepEqual(
        restored.tools.map(({ id, rtk }) => ({ id, rtk })),
        persisted,
        'confirmed per-call metadata survives a runtime restart',
      );
      assert.deepEqual(
        restored.tools.map(({ rtk }) => Boolean(rtk)),
        [true, false, false, true, true, true, true, true, true, false],
      );
      context.diagnostic(
        `real locked SDK; pinned RTK OSS ${rtkRelease.version}; project settings, npm argv/XDG, remote HEAD and merge, raw porcelain and persisted traces; paid requests=0`,
      );
    } finally {
      for (const gate of gates) gate.release();
      await app?.close();
      gateway.closeAllConnections();
      if (gateway.listening) await new Promise<void>((resolve) => gateway.close(() => resolve()));
      for (const [key, value] of oldEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
