/**
 * @file 验证停机迁入、保留旧数据与运行时写者保护。
 * @implementation 用隔离 SQLite 和真实文件记录重建工作区并核对回退副本。
 * @updated 2026-11-20T02:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileRecords } from '../server/artifacts.js';
import { fingerprint } from '../server/files.js';
import { migrateWorkspace } from '../server/data-migration.js';
import { acquireDataOwner } from '../server/data-owner.js';
import { Store } from '../server/store.js';
import { emptyDraft, now, type Run } from '../shared/types.js';

await test('migrate real application records and files while preserving the rollback copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-migration-test-'));
  const source = join(dir, 'old data');
  const target = join(dir, 'new data');
  const project = join(dir, 'project');
  const projectId = randomUUID();
  const sessionId = randomUUID();
  try {
    await mkdir(project);
    let artifactId = '';
    let attachmentId = '';
    let toolId = '';
    const logText = 'retained Bash log\n';
    const store = new Store(source);
    try {
      store.put('projects', {
        id: projectId,
        path: project,
        name: 'fixture',
        available: true,
        branch: '',
        createdAt: now(),
      });
      store.put('sessions', {
        id: sessionId,
        projectId,
        title: 'migration history',
        status: 'active',
        sdkSessionId: null,
        createdAt: now(),
        updatedAt: now(),
        draft: emptyDraft(),
      });
      const run: Run = {
        id: randomUUID(),
        projectId,
        sessionId,
        prompt: 'fixture',
        mode: 'edit',
        status: 'completed',
        createdAt: now(),
        startedAt: now(),
        endedAt: now(),
        reason: null,
        error: null,
        retryOf: null,
        contextPaths: [],
        attachmentIds: [],
        plan: [],
        usage: null,
        config: store.config(),
      };
      store.put('runs', run);
      toolId = `${run.id}:toolu_saved`;
      store.put('tools', {
        id: toolId,
        runId: run.id,
        sessionId,
        name: 'Bash',
        inputSummary: '{}',
        status: 'succeeded',
        output: 'SDK receipt',
        bashLog: {
          status: 'complete',
          bytes: Buffer.byteLength(logText),
          sourceBytes: Buffer.byteLength(logText),
        },
        startedAt: now(),
        endedAt: now(),
      });
      await mkdir(join(source, 'tool-output'), { recursive: true, mode: 0o700 });
      await writeFile(join(source, 'tool-output', `${fingerprint(toolId)}.log`), logText, {
        mode: 0o600,
      });
      const files = new FileRecords(store);
      artifactId = (await files.publish(run, 'result.md', 'migration output')).id;
      attachmentId = (
        await files.upload(
          sessionId,
          'sample.csv',
          Buffer.from('key,value\na,1').toString('base64'),
        )
      ).id;
      await mkdir(join(source, 'sdk', sessionId), { recursive: true });
      await writeFile(join(source, 'sdk', sessionId, 'fixture.jsonl'), '{"event":"fixture"}\n');
    } finally {
      store.close();
    }
    const release = acquireDataOwner(source);
    try {
      await assert.rejects(migrateWorkspace(source, target), /正在|正在使用|正由/);
    } finally {
      release();
    }
    const result = await migrateWorkspace(source, target);
    assert.equal(result.target, target);
    assert.equal(result.files, 4);
    assert.deepEqual(
      [result.projects, result.sessions, result.artifacts, result.attachments],
      [1, 1, 1, 1],
    );
    const opened = new Store(target);
    try {
      const files = new FileRecords(opened);
      assert.equal(opened.get('sessions', sessionId).title, 'migration history');
      assert.equal(await files.toolOutput(toolId, true), logText);
      assert.equal(await files.toolOutput(toolId), 'SDK receipt');
      assert.equal((await files.content(artifactId)).bytes.toString(), 'migration output');
      assert.equal(
        (await files.attachmentContent(attachmentId, sessionId)).bytes.toString(),
        'key,value\na,1',
      );
    } finally {
      opened.close();
    }
    assert.equal(
      await readFile(join(result.backupPath, 'artifacts', artifactId), 'utf8'),
      'migration output',
    );
    assert.equal(await readFile(join(source, 'artifacts', artifactId), 'utf8'), 'migration output');
    await assert.rejects(migrateWorkspace(source, target), /尚未创建/);
    await writeFile(join(source, 'artifacts', artifactId), 'corrupted output');
    const bad = join(dir, 'refused');
    await assert.rejects(migrateWorkspace(source, bad), /校验失败/);
    await assert.rejects(access(bad), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
