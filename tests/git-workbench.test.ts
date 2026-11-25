/**
 * @file 验证本机 Git 看板、开发会话和暂存提交。
 * @implementation 使用独立 SQLite、真实 Git 和回环模型验证目录生命周期、单文件索引范围及暂存提交核对。
 * @updated 2026-11-25T13:35:57+08:00
 */
import { randomUUID } from 'node:crypto';
import type { Session, Run, Project } from '../shared/types.js';
import type { GitDevelopmentPreview, GitSessionWorkspace } from '../shared/git-workbench.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import test from 'node:test';
import { commandsAvailable, runCommand } from '../server/commands.js';
import { migrateWorkspace } from '../server/data-migration.js';
import { createApp } from '../server/app.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

async function fixture<T>(work: (repo: string, data: string, base: string) => Promise<T>) {
  const base = await mkdtemp(join(tmpdir(), 'atelier-git-test-'));
  const repo = join(base, 'project');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Git fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(repo, 'same.txt'), 'base\n');
  await writeFile(join(repo, '.gitignore'), 'cache/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  try {
    return await work(repo, join(base, 'data'), base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function client(app: Awaited<ReturnType<typeof createApp>>) {
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  const boot = (await fetch(origin + '/api/bootstrap').then((res) => res.json())) as {
    csrfToken: string;
  };
  return async <T>(path: string, method = 'GET', body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(origin + path, {
      method,
      headers: { 'x-atelier-token': boot.csrfToken, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value: unknown = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value as T;
  };
}

test('Git board reads the exact stage, file diff, local refs, and paged commits', () =>
  fixture(async (repo, data, base) => {
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'branch', 'another');
    git(repo, 'update-ref', 'refs/remotes/origin/upstream', head);
    const external = join(base, 'other tree');
    git(repo, 'worktree', 'add', external, 'another');
    await writeFile(join(repo, 'same.txt'), 'staged\n');
    git(repo, 'add', 'same.txt');
    await writeFile(join(repo, 'same.txt'), 'unstaged\n');
    await writeFile(join(repo, ':literal\tfile'), 'new file\n');
    const originalIndex = await readFile(join(repo, '.git/index'));
    const app = await createApp({ root, data });
    try {
      const request = await client(app);
      const { project } = await request<{ project: { id: string } }>(
        '/api/projects',
        'POST',
        { path: repo },
        201,
      );
      const url = '/api/projects/' + project.id + '/git';
      const { worktrees, branches } = await request<{
        worktrees: { id: string; scope: string; path: string }[];
        branches: { name: string; kind: string; worktreeId?: string }[];
      }>(url);
      assert.ok(worktrees.some((item) => item.path === external && item.scope === 'external'));
      assert.ok(branches.some((item) => item.name === 'another' && item.worktreeId));
      assert.ok(branches.some((item) => item.name === 'origin/upstream' && item.kind === 'remote'));
      const files = url + '/worktrees/' + project.id;
      assert.deepEqual((await request<{ files: unknown[] }>(files + '/status')).files, [
        { path: 'same.txt', index: 'M', worktree: 'M', kind: 'tracked' },
        { path: ':literal\tfile', index: '.', worktree: '?', kind: 'untracked' },
      ]);
      for (const [layer, added] of [
        ['staged', 'staged'],
        ['unstaged', 'unstaged'],
      ]) {
        const diff = await request<{ text: string }>(files + '/diff?path=same.txt&layer=' + layer);
        assert.ok(diff.text.includes('+' + added));
      }
      const empty = await request<{ items: unknown[]; authors?: string[] }>(
        url + '/history?oid=' + head + '&offset=1',
      );
      assert.deepEqual(empty.items, []);
      const byQuery = await request<{ items: { oid: string; subject: string }[]; totalCount?: number }>(
        url + '/history?oid=' + head + '&query=' + encodeURIComponent('initial'),
      );
      assert.equal(byQuery.items.length, 1);
      assert.equal(byQuery.items[0]?.oid, head);
      const byAuthor = await request<{ items: { oid: string }[] }>(
        url + '/history?oid=' + head + '&author=' + encodeURIComponent('fixture'),
      );
      assert.equal(byAuthor.items.length, 1);
      assert.equal(byAuthor.items[0]?.oid, head);
      const byHash = await request<{ items: { oid: string }[] }>(
        url + '/history?oid=' + head + '&query=' + head.slice(0, 7),
      );
      assert.equal(byHash.items.length, 1);
      assert.equal(byHash.items[0]?.oid, head);
      const noMatch = await request<{ items: unknown[]; totalCount?: number }>(
        url + '/history?oid=' + head + '&query=' + encodeURIComponent('nonexistent-term-xyz'),
      );
      assert.deepEqual(noMatch.items, []);
      assert.equal(noMatch.totalCount, 0);
      const commit = await request<{ text: string }>(url + '/commits/' + head);
      assert.match(commit.text, /\+base/);
      assert.deepEqual(await readFile(join(repo, '.git/index')), originalIndex);
    } finally {
      await app.close();
    }
  }));

test('Git file actions update only the selected index entries and preserve working files', () =>
  fixture(async (repo, data, base) => {
    const name = ':(glob)*.txt';
    await writeFile(join(repo, name), 'new literal path\n');
    await writeFile(join(repo, 'unrelated.txt'), 'outside selected path\n');
    git(repo, 'mv', 'same.txt', 'renamed.txt');
    const initial = join(base, 'initial repository');
    await mkdir(initial);
    git(initial, 'init', '-b', 'main');
    await writeFile(join(initial, 'first.txt'), 'first file\n');

    const app = await createApp({ root, data });
    try {
      const request = await client(app);
      const bind = async (path: string) => {
        const { project } = await request<{ project: Project }>('/api/projects', 'POST', { path }, 201);
        return '/api/projects/' + project.id + '/git/worktrees/' + project.id + '/file-index';
      };
      const index = await bind(repo);
      await request(index, 'POST', { path: name, layer: 'untracked' });
      assert.equal(git(repo, 'diff', '--cached', '--name-only', '-z'), name + '\0renamed.txt\0');
      await request(index, 'POST', { path: name, layer: 'untracked' }, 404);
      await request(index, 'POST', { path: 'renamed.txt', layer: 'staged' });
      assert.equal(git(repo, 'diff', '--cached', '--name-only', '-z'), name + '\0');
      assert.equal(await readFile(join(repo, 'renamed.txt'), 'utf8'), 'base\n');
      await request(index, 'POST', { path: 'same.txt', layer: 'unstaged' });
      assert.equal(git(repo, 'diff', '--cached', '--name-only', '-z'), name + '\0same.txt\0');
      await request(index, 'POST', { path: name, layer: 'staged' });
      assert.equal(await readFile(join(repo, name), 'utf8'), 'new literal path\n');

      const firstIndex = await bind(initial);
      await request(firstIndex, 'POST', { path: 'first.txt', layer: 'untracked' });
      assert.equal(git(initial, 'diff', '--cached', '--name-only'), 'first.txt\n');
      await writeFile(join(initial, 'first.txt'), 'first file with a later edit\n');
      await request(firstIndex, 'POST', { path: 'first.txt', layer: 'staged' });
      assert.equal(git(initial, 'status', '--short'), '?? first.txt\n');
      assert.equal(await readFile(join(initial, 'first.txt'), 'utf8'), 'first file with a later edit\n');
    } finally {
      await app.close();
    }
  }));

test('development sessions use independent directories, durable branch bindings, and overlapping-run guards', () =>
  fixture(async (repo, data) => {
    await writeFile(join(repo, 'same.txt'), 'original checkout\n');
    const starts = new Map<string, { run: Run; prompt: string }>();
    const open = () =>
      createApp({
        root,
        data,
        runnerFactory: (store) => ({
          start(run, prompt) {
            starts.set(run.id, { run, prompt });
          },
          stop(id) {
            const run = store.update('runs', id, { status: 'stopped' });
            store.event(id, run.sessionId, 'run.finished', { status: 'stopped' });
          },
          async shutdown() {},
        }),
      });
    let app = await open();
    try {
      let request = await client(app);
      const { project } = await request<{ project: Project }>(
        '/api/projects',
        'POST',
        { path: repo },
        201,
      );
      const gitUrl = '/api/projects/' + project.id + '/git';
      const prepare = (branch: string, mode: 'linked' | 'in_place' = 'linked') => ({
        requestId: randomUUID(),
        branch,
        mode,
        base: { kind: 'head' },
      });
      const create = async (input: ReturnType<typeof prepare>) => {
        const preview = await request<GitDevelopmentPreview>(gitUrl + '/preview', 'POST', input);
        const full = { ...input, expectedOid: preview.oid };
        const { session, workspace } = await request<{
          session: Session;
          workspace: GitSessionWorkspace;
        }>(gitUrl + '/sessions', 'POST', full, 201);
        assert.equal(
          (await request<{ session: Session }>(gitUrl + '/sessions', 'POST', full, 201)).session.id,
          session.id,
        );
        return { session, workspace };
      };
      const one = await create(prepare('feature/login'));
      const two = await create(prepare('feature/payment'));
      assert.notEqual(one.workspace.path, two.workspace.path);
      assert.equal(one.session.draft.mode, 'edit');
      assert.equal(one.session.draft.executionPreference, 'project-v1');
      assert.equal(git(one.workspace.path, 'branch', '--show-current').trim(), 'feature/login');
      assert.equal(await readFile(join(repo, 'same.txt'), 'utf8'), 'original checkout\n');
      await writeFile(join(one.workspace.path, 'same.txt'), 'login checkout\n');
      await writeFile(join(two.workspace.path, 'same.txt'), 'payment checkout\n');
      const lookup = (item: typeof one) =>
        request<{ text: string }>(
          '/api/projects/' + project.id + '/file?path=same.txt&sessionId=' + item.session.id,
        );
      assert.equal((await lookup(one)).text, 'login checkout\n');
      await writeFile(join(one.workspace.path, 'only-in-login.txt'), 'login only');
      const fileSearch = (session: Session) =>
        request<{ items: { path: string }[] }>(
          '/api/projects/' + project.id + '/files?query=only-in-login&sessionId=' + session.id,
        );
      assert.deepEqual(
        (await fileSearch(one.session)).items.map(({ path }) => path),
        ['only-in-login.txt'],
      );
      assert.deepEqual((await fileSearch(two.session)).items, []);
      const send = (session: Session) =>
        request<{ run: Run }>(
          '/api/sessions/' + session.id + '/messages',
          'POST',
          { text: 'read same.txt', contextPaths: ['same.txt'], idempotencyKey: randomUUID() },
          202,
        );
      const [first, second] = await Promise.all([send(one.session), send(two.session)]);
      assert.equal(starts.get(first.run.id)?.run.workspacePath, one.workspace.path);
      assert.match(starts.get(first.run.id)?.prompt ?? '', /login checkout/u);
      assert.match(starts.get(second.run.id)?.prompt ?? '', /payment checkout/u);
      const inPlace = prepare('on-main', 'in_place');
      const dirty = await request<{ error: { code: string } }>(
        gitUrl + '/preview',
        'POST',
        inPlace,
        409,
      );
      assert.equal(dirty.error.code, 'GIT_DIRECTORY_DIRTY');
      await writeFile(join(repo, 'same.txt'), 'base\n');
      const { session: original } = await request<{ session: Session }>(
        '/api/sessions',
        'POST',
        { projectId: project.id },
        201,
      );
      const third = await send(original);
      const { session: same } = await request<{ session: Session }>(
        '/api/sessions',
        'POST',
        { projectId: project.id },
        201,
      );
      const conflict = await request<{ error: { code: string } }>(
        '/api/sessions/' + same.id + '/messages',
        'POST',
        { text: 'try', idempotencyKey: randomUUID() },
        409,
      );
      assert.equal(conflict.error.code, 'RUN_ACTIVE');
      const busy = await request<{ error: { code: string } }>(
        gitUrl + '/preview',
        'POST',
        inPlace,
        409,
      );
      assert.equal(busy.error.code, 'GIT_DIRECTORY_BUSY');
      for (const { run } of [first, second, third])
        await request('/api/runs/' + run.id + '/stop', 'POST', {});
      const switched = await create(inPlace);
      assert.equal(switched.workspace.path, repo);
      assert.equal(git(repo, 'branch', '--show-current').trim(), 'on-main');
      await app.close();
      app = await open();
      request = await client(app);
      const saved = await request<{ workspace: GitSessionWorkspace }>(
        '/api/sessions/' + two.session.id,
      );
      assert.deepEqual(saved.workspace, two.workspace);
      git(two.workspace.path, 'switch', '-c', 'externally-switched');
      const stale = await request<{ error: { code: string } }>(
        '/api/sessions/' + two.session.id + '/messages',
        'POST',
        { text: 'try again', idempotencyKey: randomUUID() },
        409,
      );
      assert.equal(stale.error.code, 'GIT_WORKTREE_CHANGED');
    } finally {
      await app.close();
    }
  }));

test('archive protects ignored files and restores the staged, unstaged and untracked bytes on a confirmed branch', () =>
  fixture(async (repo, data, base) => {
    let app = await createApp({ root, data });
    try {
      let request = await client(app);
      const { project } = await request<{ project: Project }>(
        '/api/projects',
        'POST',
        { path: repo },
        201,
      );
      const gitUrl = '/api/projects/' + project.id + '/git';
      const input = {
        requestId: randomUUID(),
        mode: 'linked',
        branch: 'archive-me',
        base: { kind: 'head' },
      };
      const preview = await request<GitDevelopmentPreview>(gitUrl + '/preview', 'POST', input);
      const { session, workspace } = await request<{
        session: Session;
        workspace: GitSessionWorkspace;
      }>(gitUrl + '/sessions', 'POST', { ...input, expectedOid: preview.oid }, 201);
      const work = workspace.path;
      const file = join(work, 'same.txt');
      const note = join(work, 'a new file\nwith a line break');
      const bytes = Buffer.from([3, 0, 1, 26, 255, 0, 2]);
      await writeFile(file, 'stage this\n');
      await writeFile(join(work, 'binary.dat'), bytes);
      git(work, 'add', 'same.txt', 'binary.dat');
      await writeFile(file, 'leave this unstaged\n');
      await writeFile(join(work, 'binary.dat'), Buffer.concat([bytes, bytes]));
      await writeFile(note, bytes);
      await mkdir(join(work, 'cache'));
      await writeFile(join(work, 'cache/output'), 'derived');
      const capture = () => [
        git(work, 'status', '--porcelain=v2', '-z'),
        git(work, 'diff', '--cached', '--binary', '--full-index'),
        git(work, 'diff', '--binary', '--full-index'),
      ];
      const before = capture();
      const api = '/api/sessions/' + session.id;
      const { workspace: retained } = await request<{ workspace: GitSessionWorkspace }>(
        api,
        'PATCH',
        { status: 'archived' },
      );
      assert.equal(retained.retained, 'ignored');
      assert.equal(await readFile(join(work, 'cache/output'), 'utf8'), 'derived');
      const treeApi = gitUrl + '/worktrees/' + workspace.id;
      await request(treeApi + '/cache', 'POST', { path: 'cache' });
      const operation = { requestId: randomUUID() };
      for (let i = 0; i < 2; i++) {
        const reclaimed = await request<{ workspace: GitSessionWorkspace }>(
          treeApi + '/reclaim',
          'POST',
          operation,
        );
        assert.equal(reclaimed.workspace.state, 'snapshotted');
      }
      await assert.rejects(readFile(file), { code: 'ENOENT' });
      await app.close();
      app = await createApp({ root, data });
      request = await client(app);
      const occupied = join(base, 'occupied');
      git(repo, 'worktree', 'add', occupied, 'archive-me');
      const snapshot = await request<{ workspace: GitSessionWorkspace }>(api);
      assert.equal(snapshot.workspace.needsBranch, true);
      const error = await request<{ error: { code: string } }>(
        api + '/worktree/restore',
        'POST',
        { requestId: randomUUID() },
        409,
      );
      assert.equal(error.error.code, 'GIT_RESTORE_BRANCH_REQUIRED');
      const restore = { requestId: randomUUID(), branch: 'recovered/archive-me' };
      for (let i = 0; i < 2; i++) {
        const restored = await request<{ session: Session; workspace: GitSessionWorkspace }>(
          api + '/worktree/restore',
          'POST',
          restore,
        );
        assert.equal(restored.session.status, 'active');
        assert.equal(restored.workspace.path, work);
        assert.equal(restored.workspace.state, 'ready');
      }
      assert.deepEqual(capture(), before);
      assert.deepEqual(await readFile(note), bytes);
      assert.deepEqual(await readFile(join(work, 'binary.dat')), Buffer.concat([bytes, bytes]));
      assert.equal(git(work, 'branch', '--show-current').trim(), 'recovered/archive-me');
      assert.equal(git(occupied, 'branch', '--show-current').trim(), 'archive-me');
      assert.equal(await readFile(join(repo, 'same.txt'), 'utf8'), 'base\n');
    } finally {
      await app.close();
    }
  }));

test('missing directories keep their drafts and corrupt snapshots cannot restore', () =>
  fixture(async (repo, data) => {
    const app = await createApp({ root, data });
    try {
      const request = await client(app);
      const { project } = await request<{ project: Project }>(
        '/api/projects',
        'POST',
        { path: repo },
        201,
      );
      const gitUrl = '/api/projects/' + project.id + '/git';
      async function create(branch: string) {
        const input = { requestId: randomUUID(), mode: 'linked', branch, base: { kind: 'head' } };
        const { oid } = await request<GitDevelopmentPreview>(gitUrl + '/preview', 'POST', input);
        return request<{ session: Session; workspace: GitSessionWorkspace }>(
          gitUrl + '/sessions',
          'POST',
          { ...input, expectedOid: oid },
          201,
        );
      }
      const missing = await create('missing');
      const draft = { ...missing.session.draft, text: 'Unsaved work stays in the session' };
      await request('/api/sessions/' + missing.session.id, 'PATCH', { draft });
      git(repo, 'worktree', 'remove', missing.workspace.path);
      const resumed = await request<{ session: Session; workspace: GitSessionWorkspace }>(
        '/api/sessions/' + missing.session.id,
      );
      assert.equal(resumed.workspace.state, 'missing');
      assert.equal(resumed.session.draft.text, draft.text);
      const absent = await request<{ error: { code: string } }>(
        '/api/sessions/' + missing.session.id + '/messages',
        'POST',
        { text: draft.text, idempotencyKey: randomUUID() },
        409,
      );
      assert.equal(absent.error.code, 'GIT_WORKTREE_MISSING');

      const archived = await create('snapshot');
      const uri = '/api/sessions/' + archived.session.id;
      await writeFile(join(archived.workspace.path, 'same.txt'), 'archived content\n');
      await request(uri, 'PATCH', { status: 'archived' });
      const record = app.store.gitWorktrees.byId(archived.workspace.id);
      assert.ok(record?.snapshotId);
      const manifest = join(data, 'worktree-snapshots', record.snapshotId, 'manifest.json');
      await writeFile(manifest, (await readFile(manifest, 'utf8')) + '\n');
      const failed = await request<{ error: { code: string } }>(
        uri + '/worktree/restore',
        'POST',
        { requestId: randomUUID() },
        409,
      );
      assert.equal(failed.error.code, 'GIT_SNAPSHOT_CORRUPT');
      await assert.rejects(readFile(join(archived.workspace.path, 'same.txt')), { code: 'ENOENT' });
      assert.equal((await request<{ session: Session }>(uri)).session.status, 'archived');
    } finally {
      await app.close();
    }
  }));

test('startup returns a parked checkout after interrupted reclaim and keeps intervening bytes', () =>
  fixture(async (repo, data) => {
    const { fileIdentity, LocalGit } = await import('../server/modules/git/git-cli.js');
    let app = await createApp({ root, data });
    try {
      let request = await client(app);
      const { project } = await request<{ project: Project }>(
        '/api/projects',
        'POST',
        { path: repo },
        201,
      );
      const gitUrl = '/api/projects/' + project.id + '/git';
      const input = {
        requestId: randomUUID(),
        mode: 'linked',
        branch: 'interrupted',
        base: { kind: 'head' },
      };
      const { oid } = await request<GitDevelopmentPreview>(gitUrl + '/preview', 'POST', input);
      const { session, workspace } = await request<{
        session: Session;
        workspace: GitSessionWorkspace;
      }>(gitUrl + '/sessions', 'POST', { ...input, expectedOid: oid }, 201);
      const url = '/api/sessions/' + session.id;
      await writeFile(join(workspace.path, 'same.txt'), 'saved\n');
      await request(url, 'PATCH', { status: 'archived' });
      const row = app.store.gitWorktrees.byId(workspace.id);
      assert.ok(row?.snapshotId);
      const operation = app.store.gitWorktrees.operation(row.snapshotId);
      assert.equal(operation?.state, 'completed');
      assert.ok(operation);

      // Reproduce the durable state after moving the source and before removing it.
      git(repo, 'worktree', 'add', workspace.path, workspace.branch);
      const checkout = await LocalGit.open(workspace.path);
      app.store.gitWorktrees.saveWorktree({
        ...row,
        directoryIdentity: await fileIdentity(workspace.path),
        adminIdentity: await fileIdentity(checkout.admin),
      });
      app.store.gitWorktrees.saveOperation({ ...operation, state: 'pending', finishedAt: null });
      const parked = join(data, 'worktrees', '.reclaim-' + operation.id);
      git(repo, 'worktree', 'move', workspace.path, parked);
      await writeFile(join(parked, 'same.txt'), 'changed after capture\n');
      await app.close();
      app = await createApp({ root, data });
      request = await client(app);
      const reopened = await request<{ session: Session; workspace: GitSessionWorkspace }>(url);
      assert.equal(reopened.session.status, 'archived');
      assert.equal(reopened.workspace.state, 'ready');
      assert.equal(reopened.workspace.retained, 'interrupted');
      assert.equal(
        await readFile(join(workspace.path, 'same.txt'), 'utf8'),
        'changed after capture\n',
      );
      assert.equal(app.store.gitWorktrees.operation(operation.id)?.state, 'failed');
      await assert.rejects(readFile(join(parked, 'same.txt')), { code: 'ENOENT' });
    } finally {
      await app.close();
    }
  }));

test('v7 databases retain old session drafts and continue reading the original checkout', () =>
  fixture(async (repo, data) => {
    let app = await createApp({ root, data });
    try {
      let request = await client(app);
      const { project } = await request<{ project: Project }>(
        '/api/projects',
        'POST',
        { path: repo },
        201,
      );
      const { session } = await request<{ session: Session }>(
        '/api/sessions',
        'POST',
        { projectId: project.id },
        201,
      );
      const url = '/api/sessions/' + session.id;
      await request(url, 'PATCH', { draft: { ...session.draft, text: 'Legacy draft' } });
      app.store.db.exec(
        'DROP TABLE git_commit_operations; DROP TABLE git_session_worktrees; DROP TABLE git_worktree_operations; DROP TABLE git_worktrees; PRAGMA user_version=7;',
      );
      await app.close();
      app = await createApp({ root, data });
      request = await client(app);
      const saved = await request<{ session: Session; workspace?: GitSessionWorkspace }>(url);
      assert.equal(saved.session.draft.text, 'Legacy draft');
      assert.equal(saved.workspace, undefined);
      assert.equal(app.store.db.prepare('PRAGMA user_version').get()?.user_version, 10);
      const file = await request<{ text: string }>(
        '/api/projects/' + project.id + '/file?path=same.txt&sessionId=' + session.id,
      );
      assert.equal(file.text, 'base\n');
    } finally {
      await app.close();
    }
  }));

test('reclaim keeps Git-normalized file bytes that the patches cannot reproduce', () =>
  fixture(async (repo, data) => {
    await writeFile(join(repo, '.gitattributes'), 'same.txt text eol=lf\n');
    git(repo, 'add', '.gitattributes');
    git(repo, 'commit', '-m', 'Normalize the fixture');
    const app = await createApp({ root, data });
    try {
      const request = await client(app);
      const { project } = await request<{ project: Project }>(
        '/api/projects',
        'POST',
        { path: repo },
        201,
      );
      const gitUrl = '/api/projects/' + project.id + '/git';
      const input = {
        requestId: randomUUID(),
        mode: 'linked',
        branch: 'normalized',
        base: { kind: 'head' },
      };
      const { oid } = await request<GitDevelopmentPreview>(gitUrl + '/preview', 'POST', input);
      const { session, workspace } = await request<{
        session: Session;
        workspace: GitSessionWorkspace;
      }>(gitUrl + '/sessions', 'POST', { ...input, expectedOid: oid }, 201);
      const file = join(workspace.path, 'same.txt');
      await writeFile(file, 'base\r\n');
      // Git refreshes its stat cache without changing the canonical index blob.
      git(workspace.path, 'add', 'same.txt');
      assert.equal(git(workspace.path, 'status', '--porcelain=v2'), '');
      const archived = await request<{ workspace: GitSessionWorkspace }>(
        '/api/sessions/' + session.id,
        'PATCH',
        { status: 'archived' },
      );
      assert.equal(archived.workspace.state, 'ready');
      assert.equal(await readFile(file, 'utf8'), 'base\r\n');
    } finally {
      await app.close();
    }
  }));

test('a development request ID cannot replace an existing session and HEAD follows the selected worktree', () =>
  fixture(async (repo, data) => {
    const app = await createApp({ root, data });
    try {
      const request = await client(app);
      const { project } = await request<{ project: Project }>(
        '/api/projects',
        'POST',
        { path: repo },
        201,
      );
      const { session: original } = await request<{ session: Session }>(
        '/api/sessions',
        'POST',
        { projectId: project.id },
        201,
      );
      const gitUrl = '/api/projects/' + project.id + '/git';
      const input = {
        requestId: original.id,
        mode: 'linked',
        branch: 'branch-id-check',
        base: { kind: 'head' },
      };
      const { oid } = await request<GitDevelopmentPreview>(gitUrl + '/preview', 'POST', input);
      const { session, workspace } = await request<{
        session: Session;
        workspace: GitSessionWorkspace;
      }>(gitUrl + '/sessions', 'POST', { ...input, expectedOid: oid }, 201);
      assert.notEqual(original.id, session.id);
      assert.deepEqual(
        (await request<{ session: Session }>('/api/sessions/' + original.id)).session,
        original,
      );
      await writeFile(join(workspace.path, 'same.txt'), 'new base\n');
      git(workspace.path, 'commit', '-am', 'Advance the linked branch');
      const advanced = git(workspace.path, 'rev-parse', 'HEAD').trim();
      const preview = await request<GitDevelopmentPreview>(gitUrl + '/preview', 'POST', {
        ...input,
        branch: 'new-child',
        requestId: randomUUID(),
        sourceWorktreeId: workspace.id,
      });
      assert.equal(preview.oid, advanced);
      assert.notEqual(preview.oid, oid);
    } finally {
      await app.close();
    }
  }));

test('data-root import preserves attached checkouts and accepts verified archive snapshots', () =>
  fixture(async (repo, data, base) => {
    const destination = join(base, 'imported');
    let app = await createApp({ root, data });
    try {
      let request = await client(app);
      const { project } = await request<{ project: Project }>(
        '/api/projects',
        'POST',
        { path: repo },
        201,
      );
      const url = '/api/projects/' + project.id + '/git';
      const input = {
        requestId: randomUUID(),
        branch: 'branch-for-migration',
        mode: 'linked',
        base: { kind: 'head' },
      };
      const { oid } = await request<GitDevelopmentPreview>(url + '/preview', 'POST', input);
      const { session, workspace } = await request<{
        session: Session;
        workspace: GitSessionWorkspace;
      }>(url + '/sessions', 'POST', { ...input, expectedOid: oid }, 201);
      await writeFile(join(workspace.path, 'same.txt'), 'kept during import\n');
      await app.close();
      await assert.rejects(migrateWorkspace(data, destination), { code: 'GIT_MIGRATION_LIVE' });
      assert.equal(
        await readFile(join(workspace.path, 'same.txt'), 'utf8'),
        'kept during import\n',
      );
      app = await createApp({ root, data });
      request = await client(app);
      const sessionPath = '/api/sessions/' + session.id;
      await request(sessionPath, 'PATCH', { status: 'archived' });
      await app.close();
      await migrateWorkspace(data, destination);
      app = await createApp({ root, data: destination });
      request = await client(app);
      const result = await request<{ workspace: GitSessionWorkspace }>(
        sessionPath + '/worktree/restore',
        'POST',
        { requestId: randomUUID() },
      );
      assert.equal(result.workspace.state, 'ready');
      assert.ok(result.workspace.path.startsWith(destination + '/'));
      assert.equal(
        await readFile(join(result.workspace.path, 'same.txt'), 'utf8'),
        'kept during import\n',
      );
    } finally {
      await app.close();
    }
  }));

test(
  'a linked worktree can run a controlled command with its Git metadata masked',
  {
    skip: !commandsAvailable(),
  },
  () =>
    fixture(async (repo, _data, base) => {
      const linked = join(base, 'linked sandbox fixture');
      git(repo, 'worktree', 'add', '-b', 'commands-fixture', linked, 'HEAD');
      const result = await runCommand(
        linked,
        'test -e .git && test ! -s .git && pwd && printf "%s" sandbox > same.txt',
        AbortSignal.timeout(10000),
      );
      assert.deepEqual(result, { code: 0, output: '/workspace\n', truncated: false });
      assert.equal(await readFile(join(linked, 'same.txt'), 'utf8'), 'sandbox');
      assert.equal(await readFile(join(repo, 'same.txt'), 'utf8'), 'base\n');
      assert.match(await readFile(join(linked, '.git'), 'utf8'), /^gitdir: /u);
    }),
);

test('AI commit reviews only the index and creates one commit from the edited message', () =>
  fixture(async (repo, data) => {
    const calls: unknown[] = [];
    const gateway = createServer(async (req, res) => {
      if (req.method === 'GET') return res.end('{}');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'Draft title\n\nDraft body' }] }));
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const address = gateway.address();
    assert.ok(address && typeof address === 'object');
    const app = await createApp({ root, data });
    app.store.setConfig({
      ...app.store.config(),
      gateway: 'http://127.0.0.1:' + address.port,
      model: 'git-fixture',
    });
    try {
      const request = await client(app);
      const { project } = await request<{ project: Project }>(
        '/api/projects',
        'POST',
        { path: repo },
        201,
      );
      const path = '/api/projects/' + project.id + '/git/worktrees/' + project.id;
      const start = git(repo, 'rev-parse', 'HEAD').trim();
      await writeFile(join(repo, 'same.txt'), 'first-staged-version\n');
      git(repo, 'add', 'same.txt');
      await writeFile(join(repo, 'same.txt'), 'private-unstaged-version\n');
      await writeFile(join(repo, 'untracked.txt'), 'private-untracked-file\n');
      git(repo, 'add', '-N', 'untracked.txt');
      const index = await readFile(join(repo, '.git/index'));
      const draft = await request<{
        version: string;
        files: { path: string; added: number; removed: number }[];
        suggestion: { title: string; body: string };
      }>(path + '/commit-draft', 'POST', { locale: 'en', generate: true });
      assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), start);
      assert.deepEqual(await readFile(join(repo, '.git/index')), index);
      assert.deepEqual(draft.files, [{ path: 'same.txt', added: 1, removed: 1 }]);
      assert.deepEqual(draft.suggestion, { title: 'Draft title', body: 'Draft body' });
      assert.equal(calls.length, 1);
      const prompt = JSON.stringify(calls[0]);
      assert.match(prompt, /first-staged-version/u);
      assert.doesNotMatch(prompt, /private-unstaged|private-untracked|"tools"/u);

      await writeFile(join(repo, 'same.txt'), 'second-staged-version\n');
      git(repo, 'add', 'same.txt');
      await writeFile(join(repo, 'same.txt'), 'private-unstaged-version\n');
      await request(path + '/commit', 'POST', { version: draft.version, title: 'Stale' }, 409);
      assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), start);
      const latest = await request<{ version: string }>(path + '/commit-draft', 'POST', {
        locale: 'en',
        generate: false,
      });
      git(repo, 'switch', '-c', 'moved-same-head');
      await request(
        path + '/commit',
        'POST',
        { version: latest.version, title: 'Wrong branch' },
        409,
      );
      assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), start);
      git(repo, 'switch', 'main');

      const edited = {
        version: latest.version,
        title: 'Edited "notes" $staged',
        body: 'Line 1\nLine 2',
      };
      git(repo, 'config', 'commit.gpgSign', 'true');
      const signing = await request<{ error: { code: string } }>(
        path + '/commit',
        'POST',
        edited,
        409,
      );
      assert.equal(signing.error.code, 'GIT_COMMIT_SIGNING');
      assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), start);
      git(repo, 'config', 'commit.gpgSign', 'false');
      const receipt = await request<{ oid: string }>(path + '/commit', 'POST', edited, 201);
      assert.equal(receipt.oid, git(repo, 'rev-parse', 'HEAD').trim());
      assert.equal(git(repo, 'show', 'HEAD:same.txt'), 'second-staged-version\n');
      assert.equal(
        git(repo, 'log', '-1', '--format=%B').trim(),
        'Edited "notes" $staged\n\nLine 1\nLine 2',
      );
      assert.equal(await readFile(join(repo, 'same.txt'), 'utf8'), 'private-unstaged-version\n');
      assert.equal(git(repo, 'status', '--porcelain'), ' M same.txt\n A untracked.txt\n');
      await request(path + '/commit', 'POST', edited, 409);
      assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '2');
      assert.equal(calls.length, 1);
    } finally {
      await app.close();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  }));
