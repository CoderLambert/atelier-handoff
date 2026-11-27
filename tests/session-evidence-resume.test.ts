/**
 * @file 验证网关端口变化后真实 SDK 的隐藏证据续接及当前审批策略。
 * @implementation 用隔离应用和回环模型验证旧 v1 键、内置 Shunt 换端口、独立分叉和外部网关边界，核对原始工具结果与持久 SDK 身份。
 * @updated 2026-11-27T03:06:41+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createApp } from '../server/app.js';
import { fingerprint } from '../server/files.js';
import { prepareSdkResume } from '../server/sdk-resume.js';
import { reasoningEfforts } from '../shared/types.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

const model = 'fixture-session-evidence-resume';
const readId = 'toolu_hidden_evidence';
const writeId = 'toolu_current_permission';
const writeTool = 'mcp__atelier__write_file';
const firstPrompt = 'Read evidence.txt and acknowledge completion without revealing its contents.';
const firstReply = 'SYNTHETIC_EVIDENCE_READ_WITHOUT_DISCLOSURE';
const finalReply = 'SYNTHETIC_RESUMED_AND_WRITE_DENIED';
const requestSchema = z.object({
  model: z.literal(model),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  tools: z.array(z.object({ name: z.string() })),
  output_config: z.object({ effort: z.enum(reasoningEfforts) }),
});
const resultSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))]),
  is_error: z.boolean().optional(),
});
const sessionSchema = z.object({
  id: z.string().uuid(),
  sdkSessionId: z.string().uuid().nullable(),
  sdkConfigKey: z.string().optional(),
});
const runSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  error: z.string().nullable(),
  executor: z.string(),
  mode: z.string(),
  approvalMode: z.literal('automatic').optional(),
  config: z.object({
    effort: z.enum(reasoningEfforts),
    gateway: z.string().url(),
    managedGateway: z.boolean().optional(),
  }),
});
const permissionSchema = z.object({
  id: z.string().uuid(),
  version: z.string().uuid(),
  toolCallId: z.string(),
  kind: z.string(),
  path: z.string().nullable(),
  status: z.string(),
  decisionSource: z.literal('automatic').optional(),
});
const detailSchema = z.object({
  run: runSchema,
  permissions: z.array(permissionSchema),
  tools: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
  events: z.array(z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) })),
});
const snapshotSchema = z.object({
  session: sessionSchema,
  messages: z.array(
    z.object({
      id: z.string().uuid(),
      role: z.enum(['user', 'assistant']),
      text: z.string(),
      forkAnchor: z
        .object({
          sdkSessionId: z.string().uuid(),
          messageId: z.string().uuid(),
          configKey: z.string().optional(),
        })
        .optional(),
    }),
  ),
});
type ModelRequest = z.infer<typeof requestSchema>;

function toolResults(request: ModelRequest, id: string) {
  return request.messages
    .filter(({ role }) => role === 'user')
    .flatMap(({ content }) => (Array.isArray(content) ? content : []))
    .flatMap((block: unknown) => {
      const parsed = resultSchema.safeParse(block);
      return parsed.success && parsed.data.tool_use_id === id ? [parsed.data] : [];
    });
}

function toolResult(request: ModelRequest, id: string) {
  const matches = toolResults(request, id);
  assert.equal(matches.length, 1, `exactly one native tool_result for ${id}`);
  const result = matches[0];
  assert.ok(result);
  return result;
}

function resultText(result: ReturnType<typeof toolResult>) {
  return typeof result.content === 'string'
    ? result.content
    : result.content.map(({ text }) => text).join('\n');
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

const scenarios = [
  {
    name: 'external same-port gateway resumes hidden native Read evidence and current approval policy',
    managed: false,
    changePort: false,
    fork: false,
    resumes: true,
  },
  {
    name: 'managed Shunt port change migrates a legacy v1 key and resumes hidden native Read evidence',
    managed: true,
    changePort: true,
    fork: false,
    resumes: true,
  },
  {
    name: 'managed Shunt port change resumes an independent legacy v1 fork with hidden Read evidence',
    managed: true,
    changePort: true,
    fork: true,
    resumes: true,
  },
  {
    name: 'external gateway port change restarts SDK context without hidden native Read evidence',
    managed: false,
    changePort: true,
    fork: false,
    resumes: false,
  },
] as const;

for (const scenario of scenarios)
  test(scenario.name, { skip: process.platform !== 'linux', timeout: 60_000 }, async (context) => {
    const sdkPackage = join(
      dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))),
      'package.json',
    );
    const { version } = z
      .object({ version: z.literal('0.3.332') })
      .parse(JSON.parse(await readFile(sdkPackage, 'utf8')));
    const directory = await mkdtemp(join(tmpdir(), 'atelier-session-evidence-'));
    const projectPath = join(directory, 'project');
    const evidencePath = join(projectPath, 'evidence.txt');
    const deniedPath = join(projectPath, 'must-not-exist.txt');
    const fact = `SYNTHETIC_PRIVATE_FACT_${randomUUID()}`;
    const environment = {
      HOME: join(directory, 'home'),
      SHELL: '/bin/sh',
      XDG_CONFIG_HOME: join(directory, 'home', '.config'),
      XDG_DATA_HOME: join(directory, 'home', '.local', 'share'),
      XDG_CACHE_HOME: join(directory, 'home', '.cache'),
      TMPDIR: join(directory, 'tmp'),
      ATELIER_DISABLE_SUBAGENTS: '1',
      ATELIER_MANAGED_GATEWAY: '',
      ATELIER_MANAGED_GATEWAY_TOKEN: '',
    };
    const previousEnvironment = new Map(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    const requests: ModelRequest[] = [];
    const requestOrigins: string[] = [];
    const failures: unknown[] = [];
    const gateways: Server[] = [];
    function createGateway() {
      const gateway = createServer(async (request, response) => {
        try {
          const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
          if (pathname === '/health') return response.writeHead(200).end();
          assert.equal(pathname, '/v1/messages');
          assert.equal(request.method, 'POST');
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const parsed = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          requests.push(parsed);
          requestOrigins.push(`http://${request.headers.host}`);
          switch (requests.length) {
            case 1:
              assert.equal(parsed.output_config.effort, 'low');
              assert.ok(!JSON.stringify(parsed.messages).includes(fact));
              assert.ok(parsed.tools.some(({ name }) => name === 'Read'));
              sendModelReply(response, model, [
                { id: readId, name: 'Read', input: { file_path: evidencePath } },
              ]);
              break;
            case 2:
              assert.ok(resultText(toolResult(parsed, readId)).includes(fact));
              assert.notEqual(toolResult(parsed, readId).is_error, true);
              sendModelReply(response, model, firstReply);
              break;
            case 3:
              // Inspect the first request after the config change, before this turn's tools.
              assert.equal(parsed.output_config.effort, 'high');
              if (scenario.resumes) {
                const original = requests[1];
                assert.ok(original);
                assert.deepEqual(toolResult(parsed, readId), toolResult(original, readId));
                assert.ok(resultText(toolResult(parsed, readId)).includes(fact));
              } else {
                assert.ok(!JSON.stringify(parsed.messages).includes(fact));
                assert.equal(toolResults(parsed, readId).length, 0);
              }
              assert.ok(JSON.stringify(parsed.messages).includes(firstReply));
              assert.ok(parsed.tools.some(({ name }) => name === writeTool));
              sendModelReply(response, model, [
                {
                  id: writeId,
                  name: writeTool,
                  input: {
                    path: 'must-not-exist.txt',
                    content: 'SYNTHETIC_WRITE_MUST_REQUIRE_CURRENT_APPROVAL',
                    reason: 'Verify the new turn requires explicit permission.',
                  },
                },
              ]);
              break;
            case 4: {
              const denied = toolResult(parsed, writeId);
              assert.equal(denied.is_error, true);
              assert.match(resultText(denied), /PERMISSION_DENIED|拒绝/);
              sendModelReply(response, model, finalReply);
              break;
            }
            default:
              assert.fail('unexpected extra model request');
          }
        } catch (error) {
          failures.push(error);
          sendModelReply(response, model, 'SYNTHETIC_FIXTURE_ASSERTION_FAILED');
        }
      });
      gateways.push(gateway);
      return gateway;
    }
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    let base = '';
    let token = '';
    async function http(path: string, method = 'GET', body?: unknown, status = 200) {
      assert.equal(new URL(base).hostname, '127.0.0.1');
      const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      const result: unknown = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    }
    async function send(sessionId: string, effort: 'low' | 'high', automatic: boolean) {
      return z.object({ run: runSchema }).parse(
        await http(
          `/api/sessions/${sessionId}/messages`,
          'POST',
          {
            text: automatic
              ? firstPrompt
              : 'Continue with the evidence already read; attempt the fixture write once.',
            mode: 'edit',
            executionPreference: 'project-v1',
            effort,
            ...(automatic ? { approvalMode: 'automatic' } : {}),
            idempotencyKey: randomUUID(),
          },
          202,
        ),
      ).run;
    }
    async function waitForRun(id: string, status: 'completed' | 'awaiting_permission') {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        assert.deepEqual(failures, []);
        const detail = detailSchema.parse(await http(`/api/runs/${id}`));
        assert.ok(
          !['failed', 'interrupted', 'stopped'].includes(detail.run.status),
          JSON.stringify(detail),
        );
        if (detail.run.status === status) return detail;
        assert.notEqual(detail.run.status, 'completed', `run ended before ${status}`);
        await delay(25);
      }
      assert.fail(`loopback run did not reach ${status}`);
    }
    try {
      await Promise.all(
        [projectPath, environment.HOME, environment.TMPDIR].map((path) =>
          mkdir(path, { recursive: true }),
        ),
      );
      await writeFile(evidencePath, `The fixture's hidden fact is ${fact}.\n`);
      Object.assign(process.env, environment);
      const originalGateway = createGateway();
      const gatewayUrl = await listen(originalGateway);
      if (scenario.managed) process.env.ATELIER_MANAGED_GATEWAY = gatewayUrl;
      const options = {
        root: fileURLToPath(new URL('../', import.meta.url)),
        data: join(directory, 'data'),
      };
      app = await createApp(options);
      // Configure the loopback origin before bootstrap performs its health request.
      app.store.setConfig({
        ...app.store.config(),
        gateway: gatewayUrl,
        managedGateway: scenario.managed,
        magpieEnabled: false,
        model,
        limitExecution: true,
        maxTurns: 5,
        timeoutMs: 30_000,
      });
      base = await listen(app.server);
      token = z.object({ csrfToken: z.string() }).parse(await http('/api/bootstrap')).csrfToken;
      const { project } = z
        .object({ project: z.object({ id: z.string().uuid() }) })
        .parse(await http('/api/projects', 'POST', { path: projectPath }, 201));
      const { session } = z
        .object({ session: sessionSchema })
        .parse(await http('/api/sessions', 'POST', { projectId: project.id }, 201));
      const firstRun = await send(session.id, 'low', true);
      const firstDetail = await waitForRun(firstRun.id, 'completed');
      assert.equal(firstDetail.run.executor, 'project-v1');
      assert.equal(firstDetail.run.mode, 'edit');
      assert.equal(firstDetail.run.approvalMode, 'automatic');
      assert.equal(firstDetail.run.config.effort, 'low');
      assert.deepEqual(
        firstDetail.tools.map(({ name, status }) => ({ name, status })),
        [{ name: 'Read', status: 'succeeded' }],
      );
      const first = snapshotSchema.parse(await http(`/api/sessions/${session.id}`));
      const sdkSessionId = first.session.sdkSessionId;
      assert.ok(sdkSessionId);
      assert.deepEqual(
        first.messages.map(({ role, text }) => ({ role, text })),
        [
          { role: 'user', text: firstPrompt },
          { role: 'assistant', text: firstReply },
        ],
      );
      assert.ok(first.messages.every(({ text }) => !text.includes(fact)));
      assert.equal(requests.length, 2);
      assert.deepEqual(failures, []);

      // Recreate the old implementation's exact JSON field order independently of the
      // new helper. Updating the original anchors makes this a persisted v1 fixture.
      const legacyKey = fingerprint(
        JSON.stringify({ recoveryIdentity: 1, gateway: gatewayUrl, executor: 'project-v1' }),
      );
      app.store.update('sessions', session.id, { sdkConfigKey: legacyKey });
      for (const message of first.messages) {
        assert.ok(message.forkAnchor);
        app.store.update('messages', message.id, {
          forkAnchor: { ...message.forkAnchor, configKey: legacyKey },
        });
      }
      const legacy = snapshotSchema.parse(await http(`/api/sessions/${session.id}`));
      assert.equal(legacy.session.sdkConfigKey, legacyKey);
      assert.ok(legacy.messages.every(({ forkAnchor }) => forkAnchor?.configKey === legacyKey));
      if (scenario.managed) assert.notEqual(first.session.sdkConfigKey, legacyKey);
      else assert.equal(first.session.sdkConfigKey, legacyKey);

      let targetSessionId = session.id;
      let resumeSdkSessionId = sdkSessionId;
      if (scenario.fork) {
        const anchor = legacy.messages.at(-1);
        assert.ok(anchor);
        const fork = z
          .object({ session: sessionSchema })
          .parse(
            await http(
              `/api/sessions/${session.id}/fork`,
              'POST',
              { messageId: anchor.id, idempotencyKey: randomUUID() },
              201,
            ),
          ).session;
        assert.ok(fork.sdkSessionId);
        assert.notEqual(fork.sdkSessionId, sdkSessionId);
        assert.equal(fork.sdkConfigKey, legacyKey);
        assert.equal(requests.length, 2, 'creating an independent fork makes no model request');
        targetSessionId = fork.id;
        resumeSdkSessionId = fork.sdkSessionId;
      }

      // Bind the replacement while the original still owns its port so the two origins
      // cannot accidentally be the same, then retire the original before reopening.
      const nextGatewayUrl = scenario.changePort ? await listen(createGateway()) : gatewayUrl;
      assert.equal(nextGatewayUrl !== gatewayUrl, scenario.changePort);
      if (scenario.managed && !scenario.fork) {
        await context.test('legacy managed migration validates trust, mode and executor', () => {
          const store = app?.store;
          assert.ok(store);
          const savedSession = store.get('sessions', session.id);
          const savedRun = store.get('runs', firstRun.id);
          const nextRun = {
            ...savedRun,
            config: { ...savedRun.config, gateway: nextGatewayUrl },
          };
          process.env.ATELIER_MANAGED_GATEWAY = nextGatewayUrl;
          try {
            const compatible = prepareSdkResume(store, savedSession, nextRun);
            assert.equal(compatible.resumeExisting, true);
            assert.notEqual(compatible.configKey, legacyKey);
            assert.equal(
              prepareSdkResume(
                store,
                { ...savedSession, sdkConfigKey: compatible.configKey },
                {
                  ...nextRun,
                  config: { ...nextRun.config, gateway: gatewayUrl },
                },
              ).resumeExisting,
              false,
              'a stable managed key still requires current host trust',
            );
            assert.equal(
              prepareSdkResume(store, savedSession, { ...nextRun, mode: 'readonly' })
                .resumeExisting,
              false,
            );
            assert.equal(
              prepareSdkResume(store, savedSession, { ...nextRun, executor: 'native-v1' })
                .resumeExisting,
              false,
            );
            assert.equal(
              prepareSdkResume(store, savedSession, {
                ...nextRun,
                config: { ...nextRun.config, managedGateway: false },
              }).resumeExisting,
              false,
              'external loopback cannot inherit the managed identity',
            );
            delete process.env.ATELIER_MANAGED_GATEWAY;
            assert.equal(prepareSdkResume(store, savedSession, nextRun).resumeExisting, false);
            process.env.ATELIER_MANAGED_GATEWAY = gatewayUrl;
            assert.equal(prepareSdkResume(store, savedSession, nextRun).resumeExisting, false);
            const stable = prepareSdkResume(store, savedSession, savedRun);
            assert.equal(stable.configKey, compatible.configKey, 'managed identity excludes ports');
            assert.equal(stable.resumeExisting, true);
          } finally {
            process.env.ATELIER_MANAGED_GATEWAY = gatewayUrl;
          }
        });
      }

      // Drop application memory and the source file: only the persisted SDK transcript
      // can carry the random fact into the resumed request.
      await app.close();
      app = undefined;
      if (scenario.changePort) {
        originalGateway.closeAllConnections();
        await new Promise<void>((resolve) => originalGateway.close(() => resolve()));
      }
      await rm(evidencePath);
      if (scenario.managed) process.env.ATELIER_MANAGED_GATEWAY = nextGatewayUrl;
      app = await createApp(options);
      if (!scenario.managed)
        app.store.setConfig({ ...app.store.config(), gateway: nextGatewayUrl });
      base = await listen(app.server);
      token = z.object({ csrfToken: z.string() }).parse(await http('/api/bootstrap')).csrfToken;
      const restored = app.store.get('sessions', targetSessionId);
      assert.equal(restored.sdkConfigKey, legacyKey);
      assert.equal(restored.sdkSessionId, resumeSdkSessionId);
      const secondRun = await send(targetSessionId, 'high', false);
      const pending = await waitForRun(secondRun.id, 'awaiting_permission');
      assert.equal(pending.run.config.effort, 'high');
      assert.equal(pending.run.config.gateway, nextGatewayUrl);
      assert.equal(pending.run.config.managedGateway === true, scenario.managed);
      assert.deepEqual(requestOrigins, [gatewayUrl, gatewayUrl, nextGatewayUrl]);
      assert.equal(pending.run.executor, firstDetail.run.executor);
      assert.equal(pending.run.mode, firstDetail.run.mode);
      assert.equal(pending.run.approvalMode, undefined);
      assert.equal(requests.length, 3);
      assert.equal(pending.permissions.length, 1);
      const permission = pending.permissions[0];
      assert.ok(permission);
      assert.equal(permission.status, 'pending');
      assert.equal(permission.decisionSource, undefined);
      assert.equal(permission.kind, 'write');
      assert.equal(permission.path, 'must-not-exist.txt');
      assert.ok(permission.toolCallId.endsWith(`:${writeId}`));
      await assert.rejects(readFile(deniedPath), { code: 'ENOENT' });
      const decision = z.object({ permission: permissionSchema }).parse(
        await http(`/api/permissions/${permission.id}/decision`, 'POST', {
          decision: 'deny',
          version: permission.version,
        }),
      );
      assert.equal(decision.permission.status, 'denied');
      const completed = await waitForRun(secondRun.id, 'completed');
      await assert.rejects(readFile(deniedPath), { code: 'ENOENT' });
      assert.equal(completed.permissions[0]?.status, 'denied');
      const initialization = completed.events.filter(({ type }) => type === 'sdk.initialized');
      assert.equal(initialization.length, 1);
      assert.equal(initialization[0]?.payload.resumed, scenario.resumes);
      assert.equal(
        completed.events.filter(({ type }) => type === 'sdk.context_restarted').length,
        scenario.resumes ? 0 : 1,
      );
      const second = snapshotSchema.parse(await http(`/api/sessions/${targetSessionId}`));
      if (scenario.resumes) assert.equal(second.session.sdkSessionId, resumeSdkSessionId);
      else assert.notEqual(second.session.sdkSessionId, resumeSdkSessionId);
      if (scenario.managed || !scenario.resumes)
        assert.notEqual(second.session.sdkConfigKey, legacyKey);
      else assert.equal(second.session.sdkConfigKey, legacyKey);
      assert.equal(second.messages.length, scenario.fork ? 2 : 4);
      assert.equal(second.messages.at(-1)?.text, finalReply);
      assert.ok(
        second.messages
          .slice(-2)
          .every(
            ({ forkAnchor }) =>
              forkAnchor?.sdkSessionId === second.session.sdkSessionId &&
              forkAnchor?.configKey === second.session.sdkConfigKey,
          ),
      );
      if (scenario.fork) {
        const parent = snapshotSchema.parse(await http(`/api/sessions/${session.id}`));
        assert.deepEqual(parent, legacy, 'resuming the fork leaves the source session unchanged');
      }
      assert.ok(second.messages.every(({ text }) => !text.includes(fact)));
      assert.equal(requests.length, 4);
      assert.deepEqual(requestOrigins, [gatewayUrl, gatewayUrl, nextGatewayUrl, nextGatewayUrl]);
      assert.deepEqual(failures, []);
      context.diagnostic(
        `real SDK ${version}; legacy v1 key and message anchors; two HTTP turns / four loopback model requests; ` +
          `${gatewayUrl} -> ${nextGatewayUrl}; managed=${scenario.managed}; fork=${scenario.fork}; ` +
          `hidden Read result ${scenario.resumes ? 'preserved' : 'absent'} after app restart and source removal; ` +
          `SDK session ID ${scenario.resumes ? 'unchanged' : 'replaced'}; ` +
          'effort low -> high; current manual permission denied with no file created; paid requests=0',
      );
    } finally {
      await app?.close();
      for (const gateway of gateways) {
        gateway.closeAllConnections();
        if (gateway.listening) await new Promise<void>((resolve) => gateway.close(() => resolve()));
      }
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
