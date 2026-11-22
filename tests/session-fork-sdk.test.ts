/**
 * @file 验证原生 SDK transcript 分支的隔离、安装和独立续接。
 * @implementation 使用临时数据、真实锁定 SDK 和回环模型夹具，覆盖消息截断、UUID 重映射、源目录移除及编译后的 helper。
 * @updated 2026-11-21T22:00:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { build } from 'esbuild';
import { z } from 'zod';
import { forkSessionTranscript } from '../server/session-fork-sdk.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

const recordSchema = z
  .object({
    type: z.string(),
    uuid: z.string().optional(),
    parentUuid: z.string().nullable().optional(),
    sessionId: z.string().optional(),
    message: z.object({ content: z.unknown() }).passthrough().optional(),
    customTitle: z.string().optional(),
  })
  .passthrough();

async function transcript(directory: string, sessionId: string): Promise<string> {
  for (const key of await readdir(join(directory, 'projects'))) {
    const file = join(directory, 'projects', key, `${sessionId}.jsonl`);
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  throw new Error('Expected native SDK transcript.');
}

function entries(text: string) {
  return text
    .trim()
    .split('\n')
    .map((line) => recordSchema.parse(JSON.parse(line) as unknown));
}

async function fixture(root: string) {
  const projectPath = join(root, 'project with spaces + punctuation');
  const sourceDirectory = join(root, 'source config');
  await mkdir(projectPath, { recursive: true });
  await mkdir(sourceDirectory);
  const sourceSessionId = randomUUID();
  const firstUserId = randomUUID();
  const firstReplyId = randomUUID();
  const laterUserId = randomUUID();
  const laterReplyId = randomUUID();
  const projectKey = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  const projectDirectory = join(sourceDirectory, 'projects', projectKey);
  await mkdir(projectDirectory, { recursive: true });
  const messages = [
    {
      type: 'user',
      uuid: firstUserId,
      parentUuid: null,
      message: { role: 'user', content: 'FORK_SHARED_USER' },
    },
    {
      type: 'assistant',
      uuid: firstReplyId,
      parentUuid: firstUserId,
      message: {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: 'fork-fixture',
        content: [{ type: 'text', text: 'FORK_SHARED_REPLY' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: 'user',
      uuid: laterUserId,
      parentUuid: firstReplyId,
      message: { role: 'user', content: 'FORK_EXCLUDED_USER' },
    },
    {
      type: 'assistant',
      uuid: laterReplyId,
      parentUuid: laterUserId,
      message: {
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: 'fork-fixture',
        content: [{ type: 'text', text: 'FORK_EXCLUDED_REPLY' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ].map((message) => ({
    ...message,
    sessionId: sourceSessionId,
    cwd: projectPath,
    isSidechain: false,
    version: '2.1.326',
    timestamp: new Date().toISOString(),
  }));
  const source = `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
  await writeFile(join(projectDirectory, `${sourceSessionId}.jsonl`), source);
  await writeFile(join(sourceDirectory, 'keep.txt'), 'unrelated source config');
  return {
    projectPath,
    sourceDirectory,
    sourceSessionId,
    upToMessageId: firstReplyId,
    title: 'Fork title',
    source,
    messages,
    projectKey,
  };
}

test(
  'native SDK forks cut and remap messages, install independent children, and resume after source removal',
  { timeout: 45_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'atelier-fork-sdk-'));
    const requests: string[] = [];
    const requestFailures: string[] = [];
    const gateway = createServer(async (req, res) => {
      try {
        assert.ok(req.url?.startsWith('/v1/messages'));
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = z
          .object({ messages: z.array(z.unknown()) })
          .parse(JSON.parse(Buffer.concat(chunks).toString()) as unknown);
        requests.push(JSON.stringify(body.messages));
        sendModelReply(res, 'fork-fixture', `FORK_RESUMED_${requests.length}`);
      } catch (error) {
        requestFailures.push(String(error));
        res.writeHead(400).end();
      }
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const address = gateway.address();
    assert.ok(address && typeof address === 'object');
    try {
      const data = await fixture(root);
      const originalEnvironment = { ...process.env };
      const targets = [join(root, 'first child config'), join(root, 'second child config')];
      const ids = await Promise.all(
        targets.map((targetDirectory) => forkSessionTranscript({ ...data, targetDirectory })),
      );
      assert.equal(new Set([data.sourceSessionId, ...ids]).size, 3);
      assert.ok(
        Object.keys(process.env).length === Object.keys(originalEnvironment).length &&
          Object.entries(originalEnvironment).every(([key, value]) => process.env[key] === value),
        'fork leaves the host environment unchanged',
      );
      assert.equal(requests.length, 0, 'fork itself never invokes a model');
      assert.equal(await transcript(data.sourceDirectory, data.sourceSessionId), data.source);
      assert.equal(
        await readFile(join(data.sourceDirectory, 'keep.txt'), 'utf8'),
        'unrelated source config',
      );
      assert.deepEqual(await readdir(join(data.sourceDirectory, 'projects', data.projectKey)), [
        `${data.sourceSessionId}.jsonl`,
      ]);
      const allMessageIds = new Set<string>(data.messages.map((message) => message.uuid));
      for (const [index, target] of targets.entries()) {
        const sessionId = ids[index];
        assert.ok(sessionId);
        const records = entries(await transcript(target, sessionId));
        const messages = records.filter(
          (entry) => entry.type === 'user' || entry.type === 'assistant',
        );
        assert.equal(messages.length, 2);
        for (const message of messages) {
          assert.ok(message.uuid);
          assert.equal(allMessageIds.has(message.uuid), false);
          allMessageIds.add(message.uuid);
          assert.equal(message.sessionId, sessionId);
        }
        assert.equal(messages[0]?.parentUuid, null);
        assert.equal(messages[1]?.parentUuid, messages[0]?.uuid);
        assert.deepEqual(
          messages.map((message) => message.message),
          data.messages.slice(0, 2).map((message) => message.message),
        );
        assert.equal(
          records.find((entry) => entry.type === 'custom-title')?.customTitle,
          data.title,
        );
        assert.deepEqual(await readdir(join(target, 'projects', data.projectKey)), [
          `${sessionId}.jsonl`,
        ]);
      }
      await rm(data.sourceDirectory, { recursive: true });
      for (const [index, targetDirectory] of targets.entries()) {
        const sessionId = ids[index];
        assert.ok(sessionId);
        const sdk = query({
          prompt: `FORK_CHILD_${index}`,
          options: {
            cwd: data.projectPath,
            resume: sessionId,
            model: 'fork-fixture',
            settingSources: [],
            tools: [],
            mcpServers: {},
            strictMcpConfig: true,
            maxTurns: 1,
            abortController: new AbortController(),
            env: {
              PATH: process.env.PATH,
              ANTHROPIC_API_KEY: '',
              ANTHROPIC_AUTH_TOKEN: 'fixture',
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
              CLAUDE_CONFIG_DIR: targetDirectory,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
              CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
              CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
            },
          },
        });
        const timer = setTimeout(() => sdk.close(), 15_000);
        try {
          let completed = false;
          for await (const message of sdk) {
            if (message.type !== 'result') continue;
            assert.equal(message.subtype, 'success');
            assert.equal(message.session_id, sessionId);
            completed = true;
          }
          assert.equal(completed, true);
        } finally {
          clearTimeout(timer);
          sdk.close();
        }
      }
      assert.deepEqual(requestFailures, []);
      assert.equal(requests.length, 2);
      for (const [index, body] of requests.entries()) {
        assert.ok(body.includes('FORK_SHARED_USER'));
        assert.ok(body.includes('FORK_SHARED_REPLY'));
        assert.ok(body.includes(`FORK_CHILD_${index}`));
        assert.equal(body.includes(`FORK_CHILD_${1 - index}`), false);
        assert.equal(body.includes('FORK_EXCLUDED'), false);
      }
      for (const [index, target] of targets.entries()) {
        const sessionId = ids[index];
        assert.ok(sessionId);
        const saved = await transcript(target, sessionId);
        assert.ok(saved.includes(`FORK_CHILD_${index}`));
        assert.equal(saved.includes(`FORK_CHILD_${1 - index}`), false);
      }
    } finally {
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('fork rejects missing messages and unsafe paths without changing source or existing target data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-fork-invalid-'));
  try {
    const data = await fixture(root);
    const targetDirectory = join(root, 'child');
    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, 'keep.txt'), 'existing target');
    await assert.rejects(
      forkSessionTranscript({ ...data, targetDirectory, upToMessageId: randomUUID() }),
      /not found/,
    );
    await assert.rejects(
      forkSessionTranscript({ ...data, targetDirectory, sourceSessionId: '../escape' }),
    );
    await assert.rejects(
      forkSessionTranscript({ ...data, targetDirectory: data.sourceDirectory }),
      /separate/,
    );
    const nested = join(data.sourceDirectory, 'must not be created');
    await assert.rejects(forkSessionTranscript({ ...data, targetDirectory: nested }), /separate/);
    assert.equal((await readdir(data.sourceDirectory)).includes('must not be created'), false);
    const alias = join(root, 'alias');
    await symlink(data.sourceDirectory, alias);
    await assert.rejects(
      forkSessionTranscript({ ...data, targetDirectory: alias }),
      /ordinary directories/,
    );
    await symlink(join(data.sourceDirectory, 'projects'), join(targetDirectory, 'projects'));
    await assert.rejects(
      forkSessionTranscript({ ...data, targetDirectory }),
      /ordinary directories/,
    );
    await rm(join(targetDirectory, 'projects'));
    await mkdir(join(targetDirectory, 'projects'));
    await symlink(
      join(data.sourceDirectory, 'projects', data.projectKey),
      join(targetDirectory, 'projects', data.projectKey),
    );
    await assert.rejects(
      forkSessionTranscript({ ...data, targetDirectory }),
      /ordinary directories/,
    );
    const sourceFile = join(
      data.sourceDirectory,
      'projects',
      data.projectKey,
      `${data.sourceSessionId}.jsonl`,
    );
    await rm(sourceFile);
    await symlink(join(targetDirectory, 'keep.txt'), sourceFile);
    await assert.rejects(forkSessionTranscript({ ...data, targetDirectory }), /ordinary file/);
    assert.equal(await readFile(join(targetDirectory, 'keep.txt'), 'utf8'), 'existing target');
    assert.deepEqual(await readdir(join(data.sourceDirectory, 'projects', data.projectKey)), [
      `${data.sourceSessionId}.jsonl`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('compiled runtime uses its .js fork worker with local Node and packaged SDK resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-fork-compiled-'));
  try {
    const data = await fixture(root);
    const runtime = join(root, 'packaged runtime with spaces');
    await mkdir(runtime);
    const repository = fileURLToPath(new URL('../', import.meta.url));
    await build({
      absWorkingDir: repository,
      entryPoints: [
        'server/session-fork-sdk.ts',
        'server/session-fork-sdk-worker.ts',
        'server/session-fork-sdk-protocol.ts',
        'server/session-fork-legacy.ts',
      ],
      outdir: join(runtime, 'server'),
      bundle: false,
      platform: 'node',
      format: 'esm',
      target: 'node24',
    });
    await writeFile(join(runtime, 'package.json'), '{"type":"module"}');
    await symlink(join(repository, 'node_modules'), join(runtime, 'node_modules'), 'dir');
    const module: unknown = await import(
      pathToFileURL(join(runtime, 'server/session-fork-sdk.js')).href
    );
    const compiled = z
      .object({
        forkSessionTranscript: z.custom<typeof forkSessionTranscript>(
          (value) => typeof value === 'function',
        ),
      })
      .parse(module);
    const targetDirectory = join(root, 'compiled child config');
    const id = await compiled.forkSessionTranscript({ ...data, targetDirectory });
    assert.notEqual(id, data.sourceSessionId);
    assert.equal(
      entries(await transcript(targetDirectory, id)).filter(
        (entry) => entry.type === 'user' || entry.type === 'assistant',
      ).length,
      2,
    );
    assert.equal(await transcript(data.sourceDirectory, data.sourceSessionId), data.source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
