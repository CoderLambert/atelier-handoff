/**
 * @file 测试桌面端 Git 基础 IPC 能力与安全执行服务。
 * @implementation 使用真实临时 Git 仓库，验证仓库状态检测、提交统计、分支生命周期、同步、储藏、放弃改动及异常状态中断与继续。
 * @updated 2026-11-25T03:15:00+08:00
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import {
  getGitCommitStats,
  getGitRepoStatus,
  gitAbortOp,
  gitAmendCommit,
  gitCheckoutBranch,
  gitCherryPick,
  gitContinueOp,
  gitCreateBranch,
  gitDeleteBranch,
  gitDiscardFiles,
  gitFetch,
  gitMergeBranch,
  gitPull,
  gitPush,
  gitRenameBranch,
  gitReset,
  gitRevert,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
} from '../desktop/host/git-service.mjs';

function createTestRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-git-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Atelier Tester'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('桌面端 Git 基础 IPC 能力', () => {
  test('仓库状态检测与提交统计接口', async () => {
    const { dir, cleanup } = createTestRepo();
    try {
      // 1. 初始空提交前
      const statusInitial = await getGitRepoStatus(dir);
      assert.equal(statusInitial.currentBranch, 'main');
      assert.equal(statusInitial.repoState, 'NORMAL');
      assert.equal(statusInitial.isDirty, false);
      assert.equal(statusInitial.upstream, null);
      assert.equal(statusInitial.ahead, 0);
      assert.equal(statusInitial.behind, 0);
      assert.deepEqual(statusInitial.conflictFiles, []);

      // 2. 写入文件并提交
      writeFileSync(join(dir, 'file1.txt'), 'line 1\nline 2\nline 3\n');
      const statusDirty = await getGitRepoStatus(dir);
      assert.equal(statusDirty.isDirty, true);

      execFileSync('git', ['add', 'file1.txt'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'feat: initial commit\n\nLong body content here.'], {
        cwd: dir,
      });

      const headHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      const stats = await getGitCommitStats(dir, headHash);
      assert.equal(stats.hash, headHash);
      assert.ok(stats.body.includes('feat: initial commit'));
      assert.ok(stats.body.includes('Long body content here.'));
      assert.equal(stats.filesChanged, 1);
      assert.equal(stats.insertions, 3);
      assert.equal(stats.deletions, 0);

      // 3. DETACHED HEAD 状态检测
      execFileSync('git', ['checkout', '--detach', headHash], { cwd: dir });
      const statusDetached = await getGitRepoStatus(dir);
      assert.equal(statusDetached.repoState, 'DETACHED');
      assert.ok(statusDetached.currentBranch.length > 0);

      // 切回 main
      await gitCheckoutBranch(dir, 'main');
      const statusBack = await getGitRepoStatus(dir);
      assert.equal(statusBack.repoState, 'NORMAL');
      assert.equal(statusBack.currentBranch, 'main');
    } finally {
      cleanup();
    }
  });

  test('分支生命周期管理（创建、切换、自动暂存、重命名、删除、合并）', async () => {
    const { dir, cleanup } = createTestRepo();
    try {
      writeFileSync(join(dir, 'base.txt'), 'base\n');
      execFileSync('git', ['add', 'base.txt'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });

      // 1. 创建分支
      const createRes = await gitCreateBranch(dir, 'feature-1');
      assert.equal(createRes.success, true);

      // 2. 自动暂存切换分支
      writeFileSync(join(dir, 'base.txt'), 'base modified in main\n');
      const checkoutAutoStash = await gitCheckoutBranch(dir, 'feature-1', true);
      assert.equal(checkoutAutoStash.success, true);
      const statusFeat = await getGitRepoStatus(dir);
      assert.equal(statusFeat.currentBranch, 'feature-1');
      // 改动被正确带到 feature-1
      assert.equal(statusFeat.isDirty, true);

      // 提交改动
      execFileSync('git', ['commit', '-am', 'feature change'], { cwd: dir });

      // 3. 重命名分支
      const renameRes = await gitRenameBranch(dir, 'feature-1', 'feature-renamed');
      assert.equal(renameRes.success, true);
      const statusRenamed = await getGitRepoStatus(dir);
      assert.equal(statusRenamed.currentBranch, 'feature-renamed');

      // 切回 main 并合并
      await gitCheckoutBranch(dir, 'main');
      const mergeRes = await gitMergeBranch(dir, 'feature-renamed');
      assert.equal(mergeRes.success, true);

      // 4. 删除分支
      const delRes = await gitDeleteBranch(dir, 'feature-renamed', false);
      assert.equal(delRes.success, true);
    } finally {
      cleanup();
    }
  });

  test('提交与储藏操作接口（reset, revert, cherry-pick, amend, discard, stash）', async () => {
    const { dir, cleanup } = createTestRepo();
    try {
      writeFileSync(join(dir, 'f.txt'), 'v1\n');
      execFileSync('git', ['add', 'f.txt'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'commit 1'], { cwd: dir });
      const c1Hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

      writeFileSync(join(dir, 'f.txt'), 'v2\n');
      execFileSync('git', ['commit', '-am', 'commit 2'], { cwd: dir });
      const c2Hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

      // 1. amendCommit
      const amendRes = await gitAmendCommit(dir, 'commit 2 amended');
      assert.equal(amendRes.success, true);
      const statsAmend = await getGitCommitStats(dir, 'HEAD');
      assert.equal(statsAmend.body, 'commit 2 amended');

      // 2. revert
      writeFileSync(join(dir, 'to_revert.txt'), 'revert me\n');
      execFileSync('git', ['add', 'to_revert.txt'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'commit to revert'], { cwd: dir });
      const revertRes = await gitRevert(dir, 'HEAD');
      assert.equal(revertRes.success, true);

      // 3. reset soft 回到 c1 (此时 HEAD 领先于 c1，包含 commit 2 与 revert commit)
      const resetSoft = await gitReset(dir, c1Hash, 'soft');
      assert.equal(resetSoft.success, true);
      const statusAfterSoft = await getGitRepoStatus(dir);
      assert.equal(statusAfterSoft.isDirty, true);

      // 4. reset hard 回到 c1
      const resetHard = await gitReset(dir, c1Hash, 'hard');
      assert.equal(resetHard.success, true);
      const statusAfterHard = await getGitRepoStatus(dir);
      assert.equal(statusAfterHard.isDirty, false);

      // 5. cherry-pick
      // 在新分支加一个提交
      await gitCreateBranch(dir, 'side');
      await gitCheckoutBranch(dir, 'side');
      writeFileSync(join(dir, 'side.txt'), 'side content\n');
      execFileSync('git', ['add', 'side.txt'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'side commit'], { cwd: dir });
      const sideHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

      await gitCheckoutBranch(dir, 'main');
      const cpRes = await gitCherryPick(dir, sideHash);
      assert.equal(cpRes.success, true);
      const statusAfterCp = await getGitRepoStatus(dir);
      assert.equal(statusAfterCp.isDirty, false);

      // 6. discardFiles: 丢弃已跟踪与未跟踪文件
      writeFileSync(join(dir, 'f.txt'), 'modified dirty text\n');
      writeFileSync(join(dir, 'untracked.txt'), 'untracked dirty text\n');
      assert.equal((await getGitRepoStatus(dir)).isDirty, true);

      const discardRes = await gitDiscardFiles(dir, ['f.txt', 'untracked.txt']);
      assert.equal(discardRes.success, true);
      assert.equal((await getGitRepoStatus(dir)).isDirty, false);

      // 7. 储藏操作 (stashPush, stashList, stashApply, stashPop, stashDrop)
      writeFileSync(join(dir, 'f.txt'), 'stash test change\n');
      const pushStash = await gitStashPush(dir, 'my test stash');
      assert.equal(pushStash.success, true);
      assert.equal((await getGitRepoStatus(dir)).isDirty, false);

      const stashes = await gitStashList(dir);
      assert.equal(stashes.length, 1);
      assert.ok(stashes[0]?.message.includes('my test stash'));

      const popStash = await gitStashPop(dir, 0);
      assert.equal(popStash.success, true);
      assert.equal((await getGitRepoStatus(dir)).isDirty, true);

      // 清理
      await gitDiscardFiles(dir, ['f.txt']);
    } finally {
      cleanup();
    }
  });

  test('冲突状态检测与中止/继续（MERGING, REBASING, abortOp, continueOp）', async () => {
    const { dir, cleanup } = createTestRepo();
    try {
      writeFileSync(join(dir, 'shared.txt'), 'line 1\n');
      execFileSync('git', ['add', 'shared.txt'], { cwd: dir });
      execFileSync('git', ['commit', '-m', 'c1'], { cwd: dir });

      await gitCreateBranch(dir, 'conflict-branch');

      // main 修改 shared.txt
      writeFileSync(join(dir, 'shared.txt'), 'main line\n');
      execFileSync('git', ['commit', '-am', 'main change'], { cwd: dir });

      // conflict-branch 修改 shared.txt
      await gitCheckoutBranch(dir, 'conflict-branch');
      writeFileSync(join(dir, 'shared.txt'), 'branch line\n');
      execFileSync('git', ['commit', '-am', 'branch change'], { cwd: dir });

      // 触发合并冲突
      const mergeRes = await gitMergeBranch(dir, 'main');
      assert.equal(mergeRes.success, false);

      // 状态应为 MERGING 且包含冲突文件
      const mergeStatus = await getGitRepoStatus(dir);
      assert.equal(mergeStatus.repoState, 'MERGING');
      assert.ok(mergeStatus.conflictFiles.includes('shared.txt'));

      // 中止合并
      const abortRes = await gitAbortOp(dir);
      assert.equal(abortRes.success, true);

      const statusAfterAbort = await getGitRepoStatus(dir);
      assert.equal(statusAfterAbort.repoState, 'NORMAL');
      assert.deepEqual(statusAfterAbort.conflictFiles, []);

      // 再次制造冲突并解决后调用 continueOp
      await gitMergeBranch(dir, 'main');
      assert.equal((await getGitRepoStatus(dir)).repoState, 'MERGING');

      // 解决冲突并暂存
      writeFileSync(join(dir, 'shared.txt'), 'resolved line\n');
      execFileSync('git', ['add', 'shared.txt'], { cwd: dir });

      const continueRes = await gitContinueOp(dir);
      assert.equal(continueRes.success, true);
      assert.equal((await getGitRepoStatus(dir)).repoState, 'NORMAL');
    } finally {
      cleanup();
    }
  });

  test('远端同步接口（fetch, pull, push 及 upstream/ahead/behind 计数）', async () => {
    const remote = createTestRepo();
    const local = createTestRepo();
    try {
      writeFileSync(join(remote.dir, 'r.txt'), 'remote 1\n');
      execFileSync('git', ['add', 'r.txt'], { cwd: remote.dir });
      execFileSync('git', ['commit', '-m', 'remote c1'], { cwd: remote.dir });

      // 将 remote 作为 local 的 origin
      execFileSync('git', ['remote', 'add', 'origin', remote.dir], { cwd: local.dir });
      const fetchRes = await gitFetch(local.dir, { remote: 'origin' });
      assert.equal(fetchRes.success, true);

      // reset local main to origin/main and set upstream
      execFileSync('git', ['reset', '--hard', 'origin/main'], { cwd: local.dir });
      execFileSync('git', ['branch', '--set-upstream-to=origin/main', 'main'], { cwd: local.dir });

      const statusSynced = await getGitRepoStatus(local.dir);
      assert.equal(statusSynced.upstream, 'origin/main');
      assert.equal(statusSynced.ahead, 0);
      assert.equal(statusSynced.behind, 0);

      // local 前进 1 个提交
      writeFileSync(join(local.dir, 'l.txt'), 'local\n');
      execFileSync('git', ['add', 'l.txt'], { cwd: local.dir });
      execFileSync('git', ['commit', '-m', 'local commit'], { cwd: local.dir });

      const statusAhead = await getGitRepoStatus(local.dir);
      assert.equal(statusAhead.ahead, 1);
      assert.equal(statusAhead.behind, 0);

      // push 到远端
      // 先让 remote 允许推送到当前检出分支（测试用）
      execFileSync('git', ['config', 'receive.denyCurrentBranch', 'ignore'], { cwd: remote.dir });
      const pushRes = await gitPush(local.dir, { remote: 'origin', branch: 'main' });
      assert.equal(pushRes.success, true);

      const statusAfterPush = await getGitRepoStatus(local.dir);
      assert.equal(statusAfterPush.ahead, 0);

      // pull 测试
      const pullRes = await gitPull(local.dir, { rebase: true });
      assert.equal(pullRes.success, true);
    } finally {
      remote.cleanup();
      local.cleanup();
    }
  });

  test('异常处理：执行失败捕获 stderr 且不崩溃', async () => {
    // 传入非 Git 目录
    const tempDir = mkdtempSync(join(tmpdir(), 'atelier-non-git-'));
    try {
      await assert.rejects(
        async () => {
          await getGitRepoStatus(tempDir);
        },
        (error: Error) => {
          assert.ok(error.message.includes('git') || error.message.includes('Not a git repository'));
          return true;
        },
      );

      // 删除不存在的分支
      const { dir, cleanup } = createTestRepo();
      try {
        const delRes = await gitDeleteBranch(dir, 'non-existent-branch-xyz');
        assert.equal(delRes.success, false);
        assert.ok(delRes.stderr.length > 0);
      } finally {
        cleanup();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
