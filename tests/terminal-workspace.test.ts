/**
 * @file 验证人工终端的目录预留。
 * @implementation 核对普通项目目录、失效绑定和释放后的执行拒绝，避免长期预留成为 Git 写锁。
 * @updated 2026-11-26T01:00:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalGit } from '../server/modules/git/git-cli.js';
import { terminalFixture } from './fixtures/terminal-fixture.js';

test('terminal reservation resolves the session directory without taking the Git write lock', async () => {
  const f = await terminalFixture();
  try {
    const hold = f.worktrees.reserveTerminalWorkspace(f.session, null);
    assert.equal(await hold.resolve(), f.project.path);
    assert.equal(hold.workspaceId, null);
    assert.doesNotThrow(() => f.worktrees.assertUnlocked(f.project.path));
    hold.assertSpawnAllowed();
    hold.release();
    hold.release();
    assert.throws(() => hold.assertSpawnAllowed(), { code: 'GIT_WORKTREE_CHANGED' });
    assert.throws(() => f.worktrees.reserveTerminalWorkspace(f.session, randomUUID()), {
      code: 'GIT_WORKTREE_CHANGED',
    });
  } finally {
    await f.dispose();
  }
});

test('a terminal reservation cannot resolve a replaced project directory or changed session owner', async () => {
  const f = await terminalFixture();
  try {
    const hold = f.worktrees.reserveTerminalWorkspace(f.session, null);
    f.store.update('projects', f.project.id, { path: f.base });
    await assert.rejects(hold.resolve(), { code: 'GIT_WORKTREE_CHANGED' });
    assert.throws(() => hold.assertSpawnAllowed(), { code: 'GIT_WORKTREE_CHANGED' });
  } finally {
    await f.dispose();
  }
});

// This fixture executes system Git; the root agent owns running it.
test('real Git allows stage and commit under a terminal reservation but rejects reclaim and lock races', async () => {
  const f = await terminalFixture();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    git(f.project.path, 'init', '-b', 'main');
    git(f.project.path, 'config', 'user.name', 'Terminal fixture');
    git(f.project.path, 'config', 'user.email', 'terminal@example.test');
    await writeFile(join(f.project.path, 'file.txt'), 'base\n');
    git(f.project.path, 'add', '--', 'file.txt');
    git(f.project.path, 'commit', '-m', 'Fixture base');
    const workspaceId = randomUUID();
    const session = await f.worktrees.create(f.project, {
      requestId: workspaceId,
      mode: 'linked',
      branch: 'terminal-reservation',
      base: { kind: 'head' },
      expectedOid: git(f.project.path, 'rev-parse', 'HEAD').trim(),
    });
    const hold = f.worktrees.reserveTerminalWorkspace(session, workspaceId);
    const cwd = await hold.resolve();
    await writeFile(join(cwd, 'file.txt'), 'terminal changes\n');
    await f.worktrees.writeCheckout(f.project, workspaceId, async (checkout) => {
      assert.throws(() => f.worktrees.reserveTerminalWorkspace(session, workspaceId), {
        code: 'GIT_DIRECTORY_BUSY',
      });
      await checkout.run(['add', '--', 'file.txt']);
      await checkout.run(['commit', '-m', 'Commit while terminal retains cwd']);
    });
    assert.equal(git(cwd, 'status', '--porcelain'), '');
    hold.assertSpawnAllowed();
    f.store.update('sessions', session.id, { status: 'archived' });
    const overview = await f.worktrees.overview(f.project, await LocalGit.open(f.project.path));
    assert.equal(overview.worktrees.find((tree) => tree.id === workspaceId)?.canReclaim, false);
    await assert.rejects(f.worktrees.reclaim(f.project, workspaceId, randomUUID()), {
      code: 'GIT_DIRECTORY_BUSY',
    });
    await access(cwd);
    hold.release();
    const reclaimed = await f.worktrees.reclaim(f.project, workspaceId, randomUUID());
    assert.equal(reclaimed.state, 'snapshotted');
    await assert.rejects(access(cwd), { code: 'ENOENT' });
  } finally {
    await f.dispose();
  }
});

test('real Git in-place development requires its workspace ID and resolves the project cwd', async () => {
  const f = await terminalFixture();
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', f.project.path, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Terminal fixture');
    git('config', 'user.email', 'terminal@example.test');
    await writeFile(join(f.project.path, 'file.txt'), 'base\n');
    git('add', '--', 'file.txt');
    git('commit', '-m', 'Fixture base');
    const workspaceId = randomUUID();
    const session = await f.worktrees.create(f.project, {
      requestId: workspaceId,
      mode: 'in_place',
      branch: 'terminal-in-place',
      base: { kind: 'head' },
      expectedOid: git('rev-parse', 'HEAD').trim(),
    });
    assert.throws(() => f.worktrees.reserveTerminalWorkspace(session, null), {
      code: 'GIT_WORKTREE_CHANGED',
    });
    const hold = f.worktrees.reserveTerminalWorkspace(session, workspaceId);
    assert.equal(hold.workspaceId, workspaceId);
    assert.equal(hold.path, f.project.path);
    assert.equal(await hold.resolve(), f.project.path);
    hold.assertSpawnAllowed();
    hold.release();
  } finally {
    await f.dispose();
  }
});
