/**
 * @file 验证 Git 安全文件读取、恢复日志合法推进与工作树租约管理。
 * @implementation 在独立临时目录覆盖 readRegularFileSafely、isLegalJournalAdvance 与 WorktreeLeaseManager 的核心边界与并发/释放行为。
 * @updated 2026-11-27T21:55:00+08:00
 */
import assert from 'node:assert/strict';
import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isLegalJournalAdvance } from '../server/modules/git/commit-journal.js';
import { readRegularFileSafely } from '../server/modules/git/git-safe-io.js';
import {
  directoriesOverlap,
  WorktreeLeaseManager,
} from '../server/modules/git/worktree-lease-manager.js';

describe('readRegularFileSafely', () => {
  test('reads regular files, rejects symlinks, hard links, oversized files, and honors validateStat', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'atelier-git-safe-io-'));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const regularPath = join(root, 'regular.txt');
    await writeFile(regularPath, 'hello-atelier', 'utf8');
    const ok = await readRegularFileSafely(regularPath, { maxBytes: 1024 });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.bytes.toString('utf8'), 'hello-atelier');

    const missing = await readRegularFileSafely(join(root, 'missing.txt'), { maxBytes: 1024 });
    assert.deepEqual(missing, { status: 'missing' });

    const linkPath = join(root, 'symlink.txt');
    await symlink(regularPath, linkPath);
    const unsafeSym = await readRegularFileSafely(linkPath, { maxBytes: 1024 });
    assert.equal(unsafeSym.status, 'unsafe');
    if (unsafeSym.status === 'unsafe') assert.equal(unsafeSym.reason, 'open');

    const hardPath = join(root, 'hardlink.txt');
    await link(regularPath, hardPath);
    const unsafeHard = await readRegularFileSafely(hardPath, { maxBytes: 1024 });
    assert.deepEqual(unsafeHard, { status: 'unsafe', reason: 'stat' });

    const allowMulti = await readRegularFileSafely(hardPath, {
      maxBytes: 1024,
      requireSingleLink: false,
    });
    assert.equal(allowMulti.status, 'ok');

    const largePath = join(root, 'large.txt');
    await writeFile(largePath, '0123456789', 'utf8');
    const unsafeSize = await readRegularFileSafely(largePath, { maxBytes: 4 });
    assert.deepEqual(unsafeSize, { status: 'unsafe', reason: 'size' });

    await assert.rejects(
      () =>
        readRegularFileSafely(largePath, {
          maxBytes: 1024,
          validateStat: () => {
            throw new Error('custom-stat-rejection');
          },
        }),
      /custom-stat-rejection/,
    );
  });
});

describe('isLegalJournalAdvance', () => {
  test('accepts the four legal +1 transitions and rejects skipped, stale, recovery, or illegal edges', () => {
    assert.equal(
      isLegalJournalAdvance(
        { state: 'prepared', revision: 1 },
        { state: 'ref_updated', revision: 2 },
      ),
      true,
    );
    assert.equal(
      isLegalJournalAdvance({ state: 'prepared', revision: 1 }, { state: 'aborting', revision: 2 }),
      true,
    );
    assert.equal(
      isLegalJournalAdvance(
        { state: 'ref_updated', revision: 2 },
        { state: 'completed', revision: 3 },
      ),
      true,
    );
    assert.equal(
      isLegalJournalAdvance({ state: 'aborting', revision: 2 }, { state: 'aborted', revision: 3 }),
      true,
    );

    assert.equal(
      isLegalJournalAdvance(
        { state: 'prepared', revision: 1 },
        { state: 'ref_updated', revision: 1 },
      ),
      false,
    );
    assert.equal(
      isLegalJournalAdvance(
        { state: 'prepared', revision: 1 },
        { state: 'ref_updated', revision: 3 },
      ),
      false,
    );
    assert.equal(
      isLegalJournalAdvance(
        { state: 'ref_updated', revision: 2 },
        { state: 'recovery_required', revision: 3 },
      ),
      false,
    );
    assert.equal(
      isLegalJournalAdvance(
        { state: 'prepared', revision: 1 },
        { state: 'completed', revision: 2 },
      ),
      false,
    );
    assert.equal(
      isLegalJournalAdvance(
        { state: 'completed', revision: 3 },
        { state: 'ref_updated', revision: 4 },
      ),
      false,
    );
    assert.equal(
      isLegalJournalAdvance({ state: 'aborted', revision: 3 }, { state: 'completed', revision: 4 }),
      false,
    );
  });
});

describe('WorktreeLeaseManager & directoriesOverlap', () => {
  test('detects overlapping directories accurately', () => {
    assert.equal(directoriesOverlap('/tmp/repo', '/tmp/repo'), true);
    assert.equal(directoriesOverlap('/tmp/repo', '/tmp/repo/nested'), true);
    assert.equal(directoriesOverlap('/tmp/repo/nested', '/tmp/repo'), true);
    assert.equal(directoriesOverlap('/tmp/repo-a', '/tmp/repo-b'), false);
    assert.equal(directoriesOverlap('/tmp/repo', '/tmp/repo2'), false);
  });

  test('enforces exclusive repo and path leases, notifies onReleased on error, and manages terminal reservations', async () => {
    const manager = new WorktreeLeaseManager();
    let releaseCalls = 0;
    let resumeFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      resumeFirst = resolve;
    });

    const first = manager.runExclusive(
      'repo-1',
      '/tmp/worktrees/repo-1',
      async () => {
        await firstGate;
        return 'done';
      },
      () => {
        releaseCalls += 1;
      },
    );

    assert.equal(manager.isPathBusy('/tmp/worktrees/repo-1/subdir'), true);
    assert.equal(manager.isPathBusy('/tmp/worktrees/repo-2'), false);
    assert.throws(() => manager.assertUnlocked('/tmp/worktrees/repo-1'), {
      code: 'GIT_DIRECTORY_BUSY',
    });
    assert.throws(() => manager.reserveTerminal('/tmp/worktrees/repo-1/subdir'), {
      code: 'GIT_DIRECTORY_BUSY',
    });

    await assert.rejects(
      () => manager.runExclusive('repo-1', '/tmp/worktrees/other', async () => 'nope'),
      { code: 'GIT_DIRECTORY_BUSY' },
    );
    await assert.rejects(
      () => manager.runExclusive('repo-2', '/tmp/worktrees/repo-1/nested', async () => 'nope'),
      { code: 'GIT_DIRECTORY_BUSY' },
    );

    const siblingReservation = manager.reserveTerminal('/tmp/worktrees/repo-2');
    assert.equal(siblingReservation.isActive(), true);
    assert.equal(manager.hasTerminalReservation('/tmp/worktrees/repo-2/child'), true);
    assert.equal(manager.hasTerminalReservation('/tmp/worktrees/repo-3'), false);

    resumeFirst();
    assert.equal(await first, 'done');
    assert.equal(releaseCalls, 1);
    assert.equal(manager.isPathBusy('/tmp/worktrees/repo-1'), false);

    siblingReservation.release();
    assert.equal(siblingReservation.isActive(), false);
    assert.equal(manager.hasTerminalReservation('/tmp/worktrees/repo-2'), false);

    await assert.rejects(
      () =>
        manager.runExclusive(
          'repo-1',
          '/tmp/worktrees/repo-1',
          async () => {
            throw new Error('boom');
          },
          () => {
            releaseCalls += 1;
          },
        ),
      /boom/,
    );
    assert.equal(releaseCalls, 2);
    assert.equal(manager.isPathBusy('/tmp/worktrees/repo-1'), false);
  });
});
