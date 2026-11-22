/**
 * @file 验证 SDK 命令日志的归属、文件范围和回收。
 * @implementation 使用临时 SDK 文件及 SQLite 工具记录核对截断边界、取消、子任务归属、拒绝文件及重开读取。
 * @updated 2026-11-22T22:30:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, link, symlink, unlink, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { FileRecords } from '../server/artifacts.js';
import { fingerprint } from '../server/files.js';
import { MAX_BASH_LOG_BYTES } from '../server/bash-log-capture.js';
import { emptyDraft, now } from '../shared/types.js';

test(
  'large child Bash output is bounded, remains readable after reopen and follows session cleanup',
  { skip: process.platform !== 'linux' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'atelier-log-capture-'));
    const dbRoot = join(root, 'data');
    const store = new Store(dbRoot);
    try {
      const project = store.put('projects', {
        id: randomUUID(),
        name: 'fixture',
        path: join(root, 'project'),
        branch: '',
        available: true,
        createdAt: now(),
      });
      const sdkSession = randomUUID();
      const session = store.put('sessions', {
        id: randomUUID(),
        projectId: project.id,
        title: 'fixture',
        status: 'active',
        sdkSessionId: sdkSession,
        createdAt: now(),
        updatedAt: now(),
        draft: emptyDraft(),
      });
      const run = store.put('runs', {
        id: randomUUID(),
        sessionId: session.id,
        projectId: project.id,
        mode: 'edit',
        executor: 'native-v1',
        prompt: 'fixture',
        status: 'running',
        startedAt: now(),
        endedAt: null,
        reason: null,
        error: null,
        retryOf: null,
        contextPaths: [],
        attachmentIds: [],
        plan: [],
        usage: null,
        createdAt: now(),
        config: store.config(),
      });
      const childId = `${run.id}:toolu_parent`;
      store.startSubagent({
        id: childId,
        runId: run.id,
        sessionId: session.id,
        kind: 'worker',
        title: 'fixture',
        status: 'running',
        summary: null,
        startedAt: now(),
        endedAt: null,
      });
      const sdkActor = 'sdk-child';
      const toolUse = 'toolu_example';
      const tool = store.put('tools', {
        id: `${run.id}:${sdkActor}:${toolUse}`,
        sessionId: session.id,
        runId: run.id,
        subagentId: childId,
        name: 'Bash',
        inputSummary: '{}',
        status: 'running',
        output: 'original SDK receipt',
        startedAt: now(),
        endedAt: null,
      });
      const sdkRoot = join(dbRoot, 'sdk', session.id);
      const directory = join(
        sdkRoot,
        'projects',
        project.path.replace(/[^a-zA-Z0-9]/g, '-'),
        sdkSession,
        'tool-results',
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, 'command.txt');
      const bytes = Buffer.concat([
        Buffer.alloc(MAX_BASH_LOG_BYTES - 2, 97),
        Buffer.from('🍀tail'),
      ]);
      const response = { persistedOutputPath: path, persistedOutputSize: bytes.length };
      const files = new FileRecords(store);
      const capture = (data: unknown, actor = sdkActor, signal?: AbortSignal) =>
        files.captureBashLog(tool.id, sdkRoot, sdkSession, toolUse, data, signal, actor);
      assert.equal(await capture({ stdout: 'short' }), undefined);
      assert.deepEqual(await capture(response), { status: 'unavailable' });
      await writeFile(path, bytes, { mode: 0o600 });
      assert.deepEqual(await capture(response, 'sibling'), { status: 'unavailable' });
      assert.deepEqual(await capture({ ...response, persistedOutputSize: 1 }), {
        status: 'unavailable',
      });
      assert.deepEqual(
        await capture({ ...response, persistedOutputPath: join(root, 'other.log') }),
        { status: 'unavailable' },
      );
      await assert.rejects(capture(response, sdkActor, AbortSignal.abort()));
      const alias = join(directory, 'alias.txt');
      await symlink(path, alias);
      assert.deepEqual(await capture({ ...response, persistedOutputPath: alias }), {
        status: 'unavailable',
      });
      await unlink(alias);
      await link(path, alias);
      assert.deepEqual(await capture(response), { status: 'unavailable' });
      await unlink(alias);
      const captured = await capture(response);
      assert.deepEqual(captured, {
        status: 'partial',
        bytes: MAX_BASH_LOG_BYTES - 2,
        sourceBytes: bytes.length,
      });
      store.update('tools', tool.id, { status: 'succeeded', endedAt: now(), bashLog: captured });
      const target = join(dbRoot, 'tool-output', `${fingerprint(tool.id)}.log`);
      assert.equal((await stat(target)).mode & 0o777, 0o600);
      await unlink(path);
      const reopened = new Store(dbRoot);
      try {
        const reopenedFiles = new FileRecords(reopened);
        assert.equal(await reopenedFiles.toolOutput(tool.id, false), tool.output);
        assert.equal(
          await reopenedFiles.toolOutput(tool.id, true),
          'a'.repeat(MAX_BASH_LOG_BYTES - 2),
        );
        await reopenedFiles.deleteSessionFiles(session.id);
        await assert.rejects(stat(target), { code: 'ENOENT' });
        await assert.rejects(reopenedFiles.toolOutput(tool.id, true), /日志丢失或损坏/);
      } finally {
        reopened.close();
      }
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
