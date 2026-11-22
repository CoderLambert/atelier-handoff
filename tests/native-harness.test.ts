/**
 * @file 验证真实 Agent SDK 在桌面本机执行策略下使用原生工具。
 * @implementation 使用临时项目和回环模型验证原生读写、真实 Bash 回执中的停滞提示及项目技能加载。
 * @updated 2026-11-22T17:41:05+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { AgentRunner } from '../server/agent.js';
import { Store } from '../server/store.js';
import { PermissionService } from '../server/permissions.js';
import { FileRecords } from '../server/artifacts.js';
import { emptyDraft, now, type Run } from '../shared/types.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';
import { hostEnvironment, projectInstructionContext } from '../server/native-harness.js';

test('native tool environment takes the host PATH while pairing and service credentials stay with the runtime', () => {
  const env = hostEnvironment({
    PATH: '/test/bin',
    SHELL: '/bin/zsh',
    ATELIER_HOST_SECRET: 'fixture',
    ATELIER_MAGPIE_TOKEN: 'fixture',
  });
  assert.equal(env.PATH, '/test/bin');
  assert.equal(env.SHELL, '/bin/zsh');
  assert.equal(env.ATELIER_HOST_SECRET, undefined);
  assert.equal(env.ATELIER_MAGPIE_TOKEN, undefined);
});

test('project instructions preserve the import when the complete AGENTS file exceeds the inline budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-native-instructions-'));
  try {
    await writeFile(join(root, 'CLAUDE.md'), '@AGENTS.md\n@extra.md');
    assert.ok(
      projectInstructionContext(root).includes('@AGENTS.md'),
      'missing target retains its import',
    );
    const agents = 'First rule.\n' + 'x'.repeat(16_384) + '\nFinal rule.';
    await writeFile(join(root, 'AGENTS.md'), agents);
    const excerpt = projectInstructionContext(root);
    assert.ok(excerpt.includes('AGENTS.md（节选'));
    assert.ok(excerpt.includes('First rule.'));
    assert.ok(excerpt.includes('@AGENTS.md'));
    assert.ok(excerpt.includes('@extra.md'));
    assert.ok(!excerpt.includes('Final rule.'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'real SDK receives project rules without a duplicate import and executes native tools',
  { skip: process.platform !== 'linux', timeout: 40_000 },
  async (context) => {
    const epoch = Date.now();
    context.mock.timers.enable({ apis: ['Date'], now: epoch });
    const root = await mkdtemp(join(tmpdir(), 'atelier-native-'));
    const projectPath = join(root, 'project');
    const sibling = join(root, 'sibling.txt');
    const model = 'fixture-native';
    const marker = randomUUID();
    const schema = z.object({
      messages: z.array(z.unknown()),
      tools: z.array(z.object({ name: z.string() })),
    });
    const errors: string[] = [];
    let stage = 0;
    const gateway = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const text = JSON.stringify(body.messages);
        if (++stage === 1) {
          for (const name of ['Read', 'Edit', 'Bash'])
            assert.ok(
              body.tools.some((tool) => tool.name === name),
              name,
            );
          assert.equal(text.split('NATIVE_PROJECT_INSTRUCTION').length - 1, 1);
          assert.ok(text.includes('NATIVE_AGENTS_TAIL'), 'rules past 8 KiB reach the model');
          assert.ok(text.includes('NATIVE_IMPORTED_RULE'), 'another SDK import still resolves');
          sendModelReply(res, model, [
            { name: 'Read', id: 'toolu_native_read', input: { file_path: sibling } },
          ]);
        } else if (stage === 2) {
          assert.ok(text.includes(marker), 'read returns the sibling file');
          sendModelReply(res, model, [
            {
              name: 'Edit',
              id: 'toolu_native_edit',
              input: { file_path: sibling, old_string: marker, new_string: 'changed in fixture' },
            },
          ]);
        } else if (stage >= 3 && stage <= 5) {
          context.mock.timers.setTime(epoch + (stage - 3) * 31_000);
          assert.equal(await readFile(sibling, 'utf8'), 'changed in fixture\n');
          sendModelReply(res, model, [
            {
              name: 'Bash',
              id: `toolu_native_bash_${stage}`,
              input: { command: 'pwd', description: 'Read fixture working directory' },
            },
          ]);
        } else if (stage === 6) {
          assert.ok(text.includes(projectPath));
          assert.ok(
            text.includes('当前分支多次运行相同 Bash 命令'),
            'SDK returns repeated-output feedback to the model',
          );
          sendModelReply(res, model, [
            {
              name: 'Skill',
              id: 'toolu_skill',
              input: { skill: 'workspace-skills:fixture-check' },
            },
          ]);
        } else {
          assert.ok(
            text.includes('NATIVE_SKILL_BODY'),
            'project Skill is discoverable and loaded by the real CLI',
          );
          sendModelReply(res, model, 'Fixture verified.');
        }
      } catch (error) {
        errors.push(String(error));
        res.writeHead(400).end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Fixture assertion failed' },
          }),
        );
      }
    });
    await mkdir(join(projectPath, '.claude/skills/fixture-check'), { recursive: true });
    await writeFile(
      join(projectPath, '.claude/skills/fixture-check/SKILL.md'),
      '---\nname: fixture-check\ndescription: Use for fixture checks\n---\nNATIVE_SKILL_BODY\n',
    );
    await writeFile(
      join(projectPath, 'AGENTS.md'),
      'NATIVE_PROJECT_INSTRUCTION\n' +
        'Keep changes in this fixture.\n'.repeat(300) +
        'NATIVE_AGENTS_TAIL\n',
    );
    await writeFile(join(projectPath, 'CLAUDE.md'), '@AGENTS.md\n@./AGENTS.md\n@extra.md');
    await writeFile(join(projectPath, 'extra.md'), 'NATIVE_IMPORTED_RULE\n');
    await writeFile(sibling, marker + '\n');
    await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
    const address = gateway.address();
    assert.ok(address && typeof address !== 'string');
    const store = new Store(join(root, 'data'));
    const runner = new AgentRunner(store, new PermissionService(store), new FileRecords(store));
    try {
      const project = store.put('projects', {
        id: randomUUID(),
        name: 'Fixture',
        path: projectPath,
        branch: '',
        available: true,
        createdAt: now(),
      });
      const session = store.put('sessions', {
        id: randomUUID(),
        projectId: project.id,
        title: 'Fixture',
        status: 'active',
        sdkSessionId: null,
        draft: emptyDraft(),
        createdAt: now(),
        updatedAt: now(),
      });
      const run: Run = store.put('runs', {
        id: randomUUID(),
        projectId: project.id,
        sessionId: session.id,
        prompt: 'Verify the fixture.',
        executor: 'native-v1',
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
          maxTurns: 8,
          timeoutMs: 25_000,
        },
      });
      await runner.start(run, run.prompt);
      assert.deepEqual(errors, []);
      const finished = store.get('runs', run.id);
      assert.equal(finished.status, 'completed', finished.error ?? undefined);
      assert.equal(stage, 7, 'context summary issues no model or token-count requests');
      const contextUsage = finished.contextUsage;
      assert.ok(contextUsage);
      assert.equal(contextUsage.sdkSessionId, store.get('sessions', session.id).sdkSessionId);
      assert.ok(contextUsage.windowTokens > 0);
      assert.ok(contextUsage.categories.some(({ kind }) => kind === 'used'));
      assert.deepEqual(contextUsage.requestUsage, {
        inputTokens: 12,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      assert.deepEqual(store.sessionSnapshots.read(session.id).runs[0]?.contextUsage, contextUsage);
      assert.equal(store.list('permissions').length, 0);
      assert.deepEqual(
        store.list('tools').map(({ name, status }) => [name, status]),
        [
          ['Read', 'succeeded'],
          ['Edit', 'succeeded'],
          ['Bash', 'succeeded'],
          ['Bash', 'succeeded'],
          ['Bash', 'succeeded'],
          ['Skill', 'succeeded'],
        ],
      );
    } finally {
      await runner.shutdown();
      store.close();
      gateway.closeAllConnections();
      await new Promise<void>((done) => gateway.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
