/**
 * @file 验证成果文件发布、原件读取和交付范围。
 * @implementation 用隔离存储检验发布边界、原件指纹和最新版本中的指定原文。
 * @updated 2026-11-28T19:47:32+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileRecords } from '../server/artifacts.js';
import { fingerprint } from '../server/files.js';
import {
  assertAcceptancePublication,
  checkRunAcceptance,
} from '../server/modules/runs/acceptance-check.js';
import { Store } from '../server/store.js';
import { emptyDraft, now, type Run } from '../shared/types.js';

const pdf = Buffer.concat([
  Buffer.from('%PDF-1.7\n1 0 obj\n<< /Length 5 >>\nstream\n'),
  Buffer.from([0, 0xff, 0x80, 0xc0, 0xfe]),
  Buffer.from('\nendstream\nendobj\n%%EOF\n'),
]);

async function fixture(
  work: (context: {
    base: string;
    output: string;
    store: Store;
    files: FileRecords;
    run: Run;
  }) => Promise<void>,
) {
  const base = await mkdtemp(join(tmpdir(), 'atelier-artifact-test-'));
  const output = join(base, 'output');
  await mkdir(output);
  const store = new Store(join(base, 'data'));
  const run: Run = {
    id: randomUUID(),
    sessionId: randomUUID(),
    projectId: randomUUID(),
    prompt: 'fixture',
    mode: 'readonly',
    status: 'running',
    createdAt: now(),
    startedAt: now(),
    endedAt: null,
    reason: null,
    error: null,
    retryOf: null,
    contextPaths: [],
    attachmentIds: [],
    plan: [],
    usage: null,
    config: store.config(),
  };
  store.put('sessions', {
    id: run.sessionId,
    projectId: run.projectId,
    title: 'fixture',
    status: 'active',
    sdkSessionId: null,
    createdAt: now(),
    updatedAt: now(),
    draft: emptyDraft(),
  });
  store.put('runs', run);
  try {
    await work({ base, output, store, files: new FileRecords(store), run });
  } finally {
    store.close();
    await rm(base, { recursive: true, force: true });
  }
}

test('file artifacts preserve binary PDF bytes, identity and immutable storage after scratch cleanup', async () =>
  fixture(async ({ output, store, files, run }) => {
    await mkdir(join(output, 'exports'));
    const source = join(output, 'exports', '最终报告.PDF');
    await writeFile(source, pdf);
    const artifact = await files.publishFile(run, output, source);
    assert.equal(artifact.name, '最终报告.PDF');
    assert.equal(artifact.mime, 'application/pdf');
    assert.equal(artifact.size, pdf.length);
    assert.equal(artifact.fingerprint, fingerprint(pdf));
    assert.equal(artifact.runId, run.id);
    assert.equal(artifact.sessionId, run.sessionId);
    assert.equal(artifact.projectId, run.projectId);
    assert.equal(artifact.availability, 'available');
    const stored = join(store.directory, 'artifacts', artifact.id);
    assert.notEqual((await lstat(stored)).ino, (await lstat(source)).ino);
    assert.equal((await lstat(stored)).mode & 0o777, 0o600);
    await writeFile(source, 'changed original');
    await rm(output, { recursive: true });
    assert.deepEqual((await files.content(artifact.id)).bytes, pdf);
    assert.deepEqual(store.list('artifacts'), [artifact]);
    assert.deepEqual(
      store.history(run.sessionId).map((event) => [event.type, event.payload]),
      [['artifact.created', { artifactId: artifact.id }]],
    );
    await writeFile(stored, Buffer.from('tampered'));
    await assert.rejects(files.content(artifact.id), { code: 'ARTIFACT_UNAVAILABLE' });
    assert.equal(store.get('artifacts', artifact.id).availability, 'unavailable');
  }));

test('named UTF-8 outputs preserve Markdown/CSV/BOM bytes and existing inline text publishing', async () =>
  fixture(async ({ output, files, run }) => {
    for (const [name, mime, text] of [
      ['report.MD', 'text/markdown', '﻿# 成果\r\n'],
      ['data.csv', 'text/csv', 'name,value\n示例,42\n'],
      ['results.JSON', 'application/json', '{"ok":true}\n'],
      ['prototype.html', 'text/plain', '<h1>Example</h1>'],
      ['empty.txt', 'text/plain', ''],
    ] as const) {
      const bytes = Buffer.from(text);
      await writeFile(join(output, name), bytes);
      const artifact = await files.publishFile(run, output, name);
      assert.equal(artifact.mime, mime);
      assert.deepEqual((await files.content(artifact.id)).bytes, bytes);
    }
    const inline = await files.publish(run, '../report.md', 'inline version');
    assert.equal(inline.name, 'report.md');
    assert.equal(inline.mime, 'text/markdown');
    assert.deepEqual((await files.content(inline.id)).bytes, Buffer.from('inline version'));
  }));

test('file artifacts reject escapes, links, directories and private paths without creating records', async () =>
  fixture(async ({ base, output, store, files, run }) => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'report.pdf'), pdf);
    await writeFile(join(output, 'report.pdf'), pdf);
    await writeFile(join(output, '.env.txt'), 'private');
    await mkdir(join(output, 'directory.pdf'));
    await symlink(join(outside, 'report.pdf'), join(output, 'outside.pdf'));
    await symlink(join(output, 'report.pdf'), join(output, 'inside.pdf'));
    await symlink(outside, join(output, 'linked'));
    await symlink(output, join(base, 'linked-root'));
    await link(join(outside, 'report.pdf'), join(output, 'hardlinked.pdf'));
    for (const path of [
      '../outside/report.pdf',
      join(outside, 'report.pdf'),
      `${output}-other/report.pdf`,
      'nested/../report.pdf',
      'outside.pdf',
      'inside.pdf',
      'linked/report.pdf',
      'hardlinked.pdf',
      'directory.pdf',
      '.env.txt',
      'report\0.pdf',
    ])
      await assert.rejects(files.publishFile(run, output, path));
    await assert.rejects(files.publishFile(run, join(base, 'linked-root'), 'report.pdf'));
    await assert.rejects(files.publishFile(run, output, 'missing.pdf'), {
      code: 'FILE_UNAVAILABLE',
    });
    assert.deepEqual(store.list('artifacts'), []);
    assert.deepEqual(store.history(run.sessionId), []);
    assert.ok(!(await readdir(store.directory)).includes('artifacts'));
  }));

test('file artifacts reject a directory replaced with a symlink during ingestion', async (t) =>
  fixture(async ({ base, output, store, files, run }) => {
    const nested = join(output, 'nested');
    const outside = join(base, 'outside');
    await mkdir(nested);
    await mkdir(outside);
    await writeFile(join(nested, 'report.pdf'), pdf);
    await writeFile(join(outside, 'report.pdf'), Buffer.from('%PDF-1.7\nPRIVATE\n'));
    const probe = await open(output, 'r');
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const stat = prototype.stat;
    await probe.close();
    let swapped = false;
    t.mock.method(
      prototype,
      'stat',
      async function (this: FileHandle, ...args: Parameters<FileHandle['stat']>) {
        const result = await Reflect.apply(stat, this, args);
        assert.ok(result);
        if (!swapped && result.isDirectory()) {
          swapped = true;
          await rename(nested, join(output, 'original'));
          await symlink(outside, nested);
        }
        return result;
      },
    );
    await assert.rejects(files.publishFile(run, output, 'nested/report.pdf'), {
      code: 'PATH_DENIED',
    });
    assert.equal(swapped, true);
    assert.deepEqual(store.list('artifacts'), []);
  }));

test('file artifacts enforce PDF/text types, encoding and bounded sizes before storing', async () =>
  fixture(async ({ output, store, files, run }) => {
    for (const [name, bytes, code] of [
      ['program.exe', Buffer.from('unsupported'), 'UNSUPPORTED_FILE'],
      ['fake.pdf', Buffer.from('not a PDF'), 'UNSUPPORTED_FILE'],
      ['bad.md', Buffer.from([0xc0, 0xff]), 'UNSUPPORTED_ENCODING'],
      ['binary.csv', Buffer.from('column\n\0value'), 'UNSUPPORTED_ENCODING'],
      ['large.md', Buffer.alloc(1024 * 1024 + 1, 0x61), 'ARTIFACT_TOO_LARGE'],
    ] as const) {
      await writeFile(join(output, name), bytes);
      await assert.rejects(files.publishFile(run, output, name), { code });
    }
    const oversized = await open(join(output, 'large.pdf'), 'w');
    await oversized.write(pdf);
    await oversized.truncate(16 * 1024 * 1024 + 1);
    await oversized.close();
    await assert.rejects(files.publishFile(run, output, 'large.pdf'), {
      code: 'ARTIFACT_TOO_LARGE',
    });
    await assert.rejects(files.publish(run, 'inline.txt', 'a'.repeat(1024 * 1024 + 1)), {
      code: 'ARTIFACT_TOO_LARGE',
    });
    assert.deepEqual(store.list('artifacts'), []);
    await writeFile(join(output, 'limit.txt'), Buffer.alloc(1024 * 1024, 0x61));
    const text = await files.publishFile(run, output, 'limit.txt');
    assert.equal(text.size, 1024 * 1024);
    assert.equal((await readFile(join(store.directory, 'artifacts', text.id))).length, text.size);
  }));

test('reply-only publication preflight leaves no artifact bytes or receipt', async () =>
  fixture(async ({ files, run, store, base }) => {
    const checked = files.withPublicationCheck(() => {
      throw new Error('reply only');
    });
    await assert.rejects(checked.publish(run, 'source.csv', 'copied input'), /reply only/);
    assert.deepEqual(store.repos.artifacts.listByRun(run.id), []);
    assert.equal(
      await lstat(join(base, 'data/artifacts')).then(
        () => true,
        () => false,
      ),
      false,
    );
  }));

test('delivery checks use the newest immutable version in this run and fail closed if unreadable', async () =>
  fixture(async ({ files, run, store }) => {
    const text = '请交付 report.md';
    const check = () =>
      checkRunAcceptance({
        text,
        answer: '已完成',
        run,
        store,
        files,
        signal: new AbortController().signal,
      });
    const previousRun = store.put('runs', { ...run, id: randomUUID() });
    await files.publish(previousRun, 'report.md', 'old session output');
    assert.equal((await check())[0]?.status, 'failed');
    const empty = await files.publish(run, 'report.md', '');
    assert.equal((await check())[0]?.status, 'failed');
    const corrected = await files.publish(run, 'report.md', '# corrected');
    const [ok] = await check();
    assert.equal(ok?.artifactId, corrected.id);
    assert.equal(ok?.fingerprint, corrected.fingerprint);
    assert.equal(ok?.status, 'passed');
    await writeFile(join(store.directory, 'artifacts', corrected.id), 'damaged');
    const [bad] = await check();
    assert.equal(bad?.status, 'unverified');
    assert.notEqual(bad?.artifactId, empty.id);
  }));

test('publication respects the current exclusive handoff, including a change during the write', async () =>
  fixture(async ({ files, run, store }) => {
    assert.doesNotThrow(() => assertAcceptancePublication('交付 report.md', 'notes.txt'));
    assert.throws(() => assertAcceptancePublication('只交付 report.md', 'notes.txt'), {
      code: 'ARTIFACT_OUT_OF_SCOPE',
    });
    let checks = 0;
    const scoped = files.withPublicationCheck((name) => {
      assertAcceptancePublication(++checks === 1 ? '交付 report.md' : '只回复 22', name);
    });
    await assert.rejects(scoped.publish(run, 'report.md', 'draft'), { code: 'REPLY_ONLY' });
    assert.deepEqual(store.repos.artifacts.listByRun(run.id), []);
    assert.deepEqual(await readdir(join(store.directory, 'artifacts')), []);
  }));

test('an explicitly required passage must be in the requested original, even when the answer quotes it', async () =>
  fixture(async ({ files, run, store }) => {
    const text = '只交付 handoff.md。\nhandoff.md 必须包含「/export 待核实」。';
    const check = async () =>
      (
        await checkRunAcceptance({
          text,
          answer: '/export 待核实',
          files,
          run,
          store,
          signal: new AbortController().signal,
        })
      ).find((c) => c.criterion === 'artifact_contains');
    const draft = await files.publish(run, 'handoff.md', '/status 已通过');
    const missing = await check();
    assert.equal(missing?.artifactId, draft.id);
    assert.equal(missing?.status, 'failed');
    const fixed = await files.publish(run, 'handoff.md', '/status 已通过\n/export 待核实');
    const verified = await check();
    assert.equal(verified?.artifactId, fixed.id);
    assert.equal(verified?.status, 'passed');
  }));
