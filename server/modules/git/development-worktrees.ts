/**
 * @file 绑定开发会话与实际 Git 工作目录。
 * @implementation 协调工作树创建、切换、查询与写租约预留，将路径守卫和回收/恢复流程委托给独立子模块。
 * @updated 2026-11-27T12:45:00-06:00
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DevelopmentCreate,
  DevelopmentPreview,
  GitDevelopmentPreview,
  GitOverview,
  GitSessionWorkspace,
  GitRestoreRequest,
  GitRetentionReason,
} from '../../../shared/git-workbench.js';
import { emptyDraft, type Project, type Run, type Session } from '../../../shared/types.js';
import { AppError, now } from '../../../shared/errors.js';
import { fingerprint, resolveProjectPath } from '../../files.js';
import type { Store } from '../../store.js';
import { fileIdentity, gitError, LocalGit } from './git-cli.js';
import { readGitOverview, readGitStatus } from './git-reader.js';
import { WorktreeSnapshots } from './worktree-snapshots.js';
import { directoriesOverlap, WorktreeLeaseManager } from './worktree-lease-manager.js';
import type { WorktreeOperation, WorktreeRecord } from './worktree-repository.js';
import {
  assertIdleGit,
  checkWorktreeCheckout,
  needsRestoreBranch,
  openWorktreeRepository,
  pathExists,
  retentionReason,
  scratchPath,
  worktreePath,
} from './worktree-guards.js';
import {
  reclaimWorktree,
  recoverWorktrees,
  restoreWorktree,
  type WorktreeLifecycleContext,
} from './worktree-lifecycle.js';

export { assertIdleGit, directoriesOverlap, pathExists };

interface WorktreeDependencies {
  inUse(path: string): boolean;
  closeDirectory(path: string): Promise<void>;
  released(): void;
}

export interface TerminalWorkspaceReservation {
  readonly projectId: string;
  readonly sessionId: string;
  readonly workspaceId: string | null;
  readonly path: string;
  resolve(): Promise<string>;
  assertSpawnAllowed(): void;
  release(): void;
}

export class DevelopmentWorktrees {
  readonly managed: string;
  private readonly snapshots: WorktreeSnapshots;
  private readonly leaseManager = new WorktreeLeaseManager();

  constructor(
    private readonly store: Store,
    directory: string,
    private readonly dependencies: WorktreeDependencies,
  ) {
    this.managed = join(directory, 'worktrees');
    this.snapshots = new WorktreeSnapshots(directory);
  }

  private get records() {
    return this.store.gitWorktrees;
  }

  private path(project: Project, row: WorktreeRecord) {
    return worktreePath(this.managed, project, row);
  }

  private lifecycleContext(): WorktreeLifecycleContext {
    return {
      store: this.store,
      managed: this.managed,
      snapshots: this.snapshots,
      leaseManager: this.leaseManager,
      dependencies: this.dependencies,
      runIdempotentWorktreeOp: (options) => this.runIdempotentWorktreeOp(options),
      checkManaged: (path) => this.checkManaged(path),
      owned: (project, id) => this.owned(project, id),
      allArchived: (row) => this.allArchived(row),
      state: (project, row) => this.state(project, row),
      finish: (row, operation) => this.finish(row, operation),
      fail: (row, operation, error, reason) => this.fail(row, operation, error, reason),
      completeCreate: (project, row, operation) => this.completeCreate(project, row, operation),
    };
  }

  directory(session: Session) {
    const project = this.store.get('projects', session.projectId);
    const row = this.records.forSession(session.id);
    return row ? this.path(project, row) : project.path;
  }

  /** Retain a directory without occupying the short-lived Git write lease. */
  reserveTerminalWorkspace(
    session: Session,
    expectedWorkspaceId: string | null,
  ): TerminalWorkspaceReservation {
    const workspaceId = this.records.forSession(session.id)?.id ?? null;
    if (workspaceId !== expectedWorkspaceId)
      throw gitError('WORKTREE_CHANGED', '会话工作目录已变化，请重新打开终端。');
    const path = this.directory(session);
    const reservation = this.leaseManager.reserveTerminal(path);
    const assertSpawnAllowed = () => {
      const current = this.store.get('sessions', session.id);
      if (
        !reservation.isActive() ||
        current.projectId !== session.projectId ||
        (this.records.forSession(session.id)?.id ?? null) !== workspaceId ||
        this.directory(current) !== path
      )
        throw gitError('WORKTREE_CHANGED', '终端的工作目录预留已失效。');
      this.assertUnlocked(path);
    };
    return {
      projectId: session.projectId,
      sessionId: session.id,
      workspaceId,
      path,
      assertSpawnAllowed,
      release: reservation.release,
      resolve: async () => {
        try {
          assertSpawnAllowed();
          const resolved = await this.resolveSession(this.store.get('sessions', session.id));
          assertSpawnAllowed();
          if (resolved !== path) throw gitError('WORKTREE_CHANGED', '终端的工作目录已变化。');
          return resolved;
        } catch (error) {
          reservation.release();
          throw error;
        }
      },
    };
  }

  assertUnlocked(path: string) {
    this.leaseManager.assertUnlocked(path);
  }

  private async exclusive<T>(git: LocalGit, path: string, work: () => Promise<T>) {
    return this.leaseManager.runExclusive(git.repositoryId, path, work, () =>
      this.dependencies.released(),
    );
  }

  private async runIdempotentWorktreeOp<T>(options: {
    requestId: string;
    requestHash: string;
    allowFailedReplay?: boolean;
    onReplay: (prior: WorktreeOperation) => Promise<T> | T;
    prepareTarget: () => Promise<{ git: LocalGit; path: string }>;
    execute: (target: { git: LocalGit; path: string }) => Promise<T>;
  }): Promise<T> {
    const checkReplay = () => {
      const prior = this.records.operation(options.requestId);
      if (!prior) return undefined;
      if (
        !options.allowFailedReplay ||
        prior.requestHash !== options.requestHash ||
        prior.state === 'pending'
      ) {
        this.result(prior, options.requestHash);
      }
      return prior;
    };
    const initial = checkReplay();
    if (initial) return options.onReplay(initial);
    const target = await options.prepareTarget();
    return this.exclusive(target.git, target.path, async () => {
      const repeated = checkReplay();
      if (repeated) return options.onReplay(repeated);
      return options.execute(target);
    });
  }

  private async checkManaged(path: string) {
    if (this.store.list('projects').some((project) => directoriesOverlap(path, project.path)))
      throw gitError('DIRECTORY_OVERLAP', '受管工作树位置与已授权项目目录重叠。');
    await mkdir(this.managed, { recursive: true, mode: 0o700 });
    await fileIdentity(this.managed);
  }

  private async state(project: Project, row: WorktreeRecord): Promise<GitSessionWorkspace> {
    const path = this.path(project, row);
    const common = {
      id: row.id,
      path,
      branch: row.branch,
      mode: row.mode,
      ...(row.retained ? { retained: row.retained } : {}),
    };
    if (this.leaseManager.isPathBusy(path)) return { ...common, state: 'busy' };
    if (row.retained === 'relocated' && row.snapshotId) {
      const retainedPath = scratchPath(this.managed, 'reclaim', row.snapshotId);
      if (await pathExists(retainedPath)) return { ...common, state: 'changed', retainedPath };
    }
    if (!(await pathExists(path))) {
      if (!row.snapshotId) return { ...common, state: 'missing' };
      const saved = this.records.operation(row.snapshotId);
      const needsBranch = saved
        ? await openWorktreeRepository(project, row)
            .then((git) => needsRestoreBranch(git, saved.branch, saved.oid))
            .catch(() => false)
        : false;
      return { ...common, state: 'snapshotted', ...(needsBranch ? { needsBranch } : {}) };
    }
    if (!row.directoryIdentity) return { ...common, state: 'changed' };
    try {
      await checkWorktreeCheckout(row, path);
      return { ...common, state: 'ready' };
    } catch {
      return { ...common, state: 'changed' };
    }
  }

  async sessionWorkspace(session: Session) {
    const row = this.records.forSession(session.id);
    return row && this.state(this.store.get('projects', session.projectId), row);
  }

  async resolveSession(session: Session) {
    const project = this.store.get('projects', session.projectId);
    const row = this.records.forSession(session.id);
    const path = row ? this.path(project, row) : project.path;
    this.assertUnlocked(path);
    if (!row) return resolveProjectPath(path, '', { directory: true });
    if (!(await pathExists(path)))
      throw gitError('WORKTREE_MISSING', '工作树缺失。请先恢复，或在系统 Git 中检查目录。');
    if (!row.directoryIdentity) throw gitError('WORKTREE_CHANGED', '工作树尚未核对。');
    try {
      await checkWorktreeCheckout(row, path);
    } catch (error) {
      if (error instanceof AppError && error.code === 'GIT_UNAVAILABLE') throw error;
      throw gitError('WORKTREE_CHANGED', '工作树位置、仓库身份或分支已变化。');
    }
    return path;
  }

  async verifyRun(run: Run) {
    if (!run.workspacePath) return;
    const path = await this.resolveSession(this.store.get('sessions', run.sessionId));
    if (path !== run.workspacePath)
      throw gitError('WORKTREE_CHANGED', '本轮工作树已变化，请重新发送。');
  }

  async overview(project: Project, git: LocalGit, signal?: AbortSignal): Promise<GitOverview> {
    const overview = await readGitOverview(git, project.id, signal);
    for (const row of this.records.byProject(project.id)) {
      if (row.mode !== 'linked') continue;
      const state = await this.state(project, row);
      const listed = overview.worktrees.find((entry) => entry.path === state.path);
      overview.worktrees = overview.worktrees.filter((entry) => entry.path !== state.path);
      overview.worktrees.push({
        ...state,
        branch: listed ? listed.branch : state.branch,
        head: listed?.head ?? null,
        locked: listed?.locked ?? false,
        scope: 'managed',
        canReclaim:
          state.state === 'ready' &&
          !listed?.locked &&
          this.allArchived(row) &&
          !this.leaseManager.hasTerminalReservation(state.path),
      });
      if (listed)
        for (const branch of overview.branches)
          if (branch.worktreeId === listed.id) branch.worktreeId = row.id;
    }
    return overview;
  }

  async checkout(project: Project, id: string, signal?: AbortSignal) {
    if (id === project.id)
      return { git: await LocalGit.open(project.path, signal), rebuildable: [] };
    const row = this.records.byId(id);
    if (row?.projectId !== project.id || row.mode !== 'linked')
      throw gitError('WORKTREE_MISSING', '所选工作树不属于此项目。', 404);
    const path = this.path(project, row);
    this.assertUnlocked(path);
    if (!row.directoryIdentity || !(await pathExists(path)))
      throw gitError('WORKTREE_MISSING', '此工作树当前不可用。', 404);
    return {
      git: (await checkWorktreeCheckout(row, path, signal)).git,
      rebuildable: row.rebuildable,
    };
  }

  async writeCheckout<T>(project: Project, id: string, write: (git: LocalGit) => Promise<T>) {
    const { git } = await this.checkout(project, id);
    return this.exclusive(git, git.root, async () => {
      if (this.dependencies.inUse(git.root))
        throw gitError('DIRECTORY_BUSY', '此工作目录有活动运行、审批或待处理消息。');
      return write(git);
    });
  }

  private async previewFor(
    project: Project,
    git: LocalGit,
    input: DevelopmentPreview,
  ): Promise<GitDevelopmentPreview> {
    await git.checkNewBranch(input.branch);
    const source =
      input.base.kind === 'head' && input.sourceWorktreeId && input.sourceWorktreeId !== project.id
        ? (await this.checkout(project, input.sourceWorktreeId)).git
        : git;
    if (source.repositoryId !== git.repositoryId)
      throw gitError('WORKTREE_CHANGED', '来源工作树不属于当前仓库。');
    const oid = await source.startPoint(input.base);
    const path = input.mode === 'linked' ? join(this.managed, input.requestId) : project.path;
    if (input.mode === 'linked') {
      await this.checkManaged(path);
      if (await pathExists(path)) throw gitError('DESTINATION_EXISTS', '目标工作树目录已存在。');
    } else {
      if (this.dependencies.inUse(path))
        throw gitError('DIRECTORY_BUSY', '原目录有活动运行、审批或待处理消息。');
      await assertIdleGit(git);
      if ((await readGitStatus(git, undefined, false)).files.length)
        throw gitError('DIRECTORY_DIRTY', '原目录必须没有暂存、未暂存或未跟踪的文件。');
    }
    return { path, oid, branch: input.branch };
  }

  async preview(project: Project, input: DevelopmentPreview) {
    const path = input.mode === 'linked' ? join(this.managed, input.requestId) : project.path;
    this.assertUnlocked(path);
    return this.previewFor(project, await LocalGit.open(project.path), input);
  }

  private result(prior: WorktreeOperation | undefined, requestHash: string) {
    if (!prior) return undefined;
    if (prior.requestHash !== requestHash)
      throw gitError('OPERATION_CONFLICT', '请求编号已用于另一项 Git 操作。');
    if (prior.state === 'pending') throw gitError('DIRECTORY_BUSY', 'Git 操作正在处理。');
    if (prior.state === 'failed')
      throw gitError('OPERATION_FAILED', '先前的 Git 操作未完成。请检查工作树后重新发起。');
    return prior;
  }

  private finishCreate(
    project: Project,
    row: WorktreeRecord,
    operation: WorktreeOperation,
    identity: string,
    admin: string,
  ) {
    if (!operation.sessionId) throw gitError('OPERATION_FAILED', '开发会话记录缺少编号。');
    const session: Session = {
      id: operation.sessionId,
      projectId: project.id,
      title: row.branch,
      status: 'active',
      sdkSessionId: null,
      createdAt: operation.createdAt,
      updatedAt: now(),
      draft: { ...emptyDraft(), mode: 'edit', executionPreference: 'project-v1' },
    };
    return this.store.transaction(() => {
      this.records.saveWorktree({
        ...row,
        retained: null,
        directoryIdentity: identity,
        adminIdentity: admin,
      });
      if (this.store.list('sessions').some(({ id }) => id === session.id))
        throw gitError('OPERATION_CONFLICT', '会话编号已被占用。');
      this.store.put('sessions', session);
      this.records.bind(session.id, row.id);
      this.records.saveOperation({ ...operation, state: 'completed', finishedAt: now() });
      this.store.event('session-' + session.id, session.id, 'session.created', {
        worktreeId: row.id,
      });
      return session;
    });
  }

  private async completeCreate(
    project: Project,
    row: WorktreeRecord,
    operation: WorktreeOperation,
  ) {
    const { git, entry, identity, admin } = await checkWorktreeCheckout(
      row,
      this.path(project, row),
    );
    if (entry.head !== operation.oid || (await readGitStatus(git, undefined, false)).files.length)
      throw gitError('WORKTREE_CHANGED', '新检出与预览基线不一致。');
    return this.finishCreate(project, row, operation, identity, admin);
  }

  async create(project: Project, input: DevelopmentCreate) {
    const requestHash = fingerprint(JSON.stringify([project.id, 'create', input]));
    return this.runIdempotentWorktreeOp({
      requestId: input.requestId,
      requestHash,
      onReplay: (replay) => {
        if (!replay.sessionId) throw gitError('OPERATION_FAILED', '开发会话记录缺少编号。');
        return this.store.get('sessions', replay.sessionId);
      },
      prepareTarget: async () => ({
        git: await LocalGit.open(project.path),
        path: input.mode === 'linked' ? join(this.managed, input.requestId) : project.path,
      }),
      execute: async ({ git }) => {
        const preview = await this.previewFor(project, git, input);
        if (preview.oid !== input.expectedOid)
          throw gitError('BASE_CHANGED', '基线已变化，请重新预览后创建。');
        const row: WorktreeRecord = {
          id: input.requestId,
          projectId: project.id,
          repositoryId: git.repositoryId,
          mode: input.mode,
          branch: input.branch,
          directoryIdentity: null,
          adminIdentity: null,
          snapshotId: null,
          snapshotDigest: null,
          retained: null,
          rebuildable: [],
        };
        const operation: WorktreeOperation = {
          id: row.id,
          worktreeId: row.id,
          requestHash,
          kind: 'create',
          state: 'pending',
          sessionId: randomUUID(),
          branch: row.branch,
          oid: preview.oid,
          createdAt: now(),
          finishedAt: null,
          scratchIdentity: null,
          error: null,
        };
        this.store.transaction(() => {
          this.records.saveWorktree(row);
          this.records.saveOperation(operation);
        });
        try {
          if (input.mode === 'linked')
            await git.run(['worktree', 'add', '-b', input.branch, '--', preview.path, preview.oid]);
          else {
            await this.dependencies.closeDirectory(preview.path);
            await git.run([
              'switch',
              '--no-guess',
              '--no-overwrite-ignore',
              '-c',
              input.branch,
              preview.oid,
            ]);
          }
          return await this.completeCreate(project, row, operation);
        } catch (error) {
          // Git may already have created part of the checkout. Keep its files and branch.
          this.fail(row, operation, error);
          throw error;
        }
      },
    });
  }

  private owned(project: Project, id: string) {
    const row = this.records.byId(id);
    if (row?.projectId !== project.id || row.mode !== 'linked')
      throw gitError('WORKTREE_MISSING', '所选工作树不属于此项目。', 404);
    return row;
  }

  private allArchived(row: WorktreeRecord) {
    const ids = this.records.sessions(row.id);
    return (
      ids.length > 0 && ids.every((id) => this.store.get('sessions', id).status === 'archived')
    );
  }

  private notifySessions(worktreeId: string, except?: string | null) {
    for (const sessionId of this.records.sessions(worktreeId))
      if (sessionId !== except)
        this.store.event('session-' + sessionId, sessionId, 'session.worktree_changed', {
          worktreeId,
        });
  }

  private finish(row: WorktreeRecord, operation: WorktreeOperation) {
    this.records.saveWorktree(row);
    this.records.saveOperation({ ...operation, state: 'completed', finishedAt: now() });
    this.notifySessions(row.id, operation.sessionId);
  }

  private fail(
    row: WorktreeRecord,
    operation: WorktreeOperation,
    error: unknown,
    reason: GitRetentionReason = 'interrupted',
  ) {
    this.store.transaction(() => {
      this.records.saveWorktree({ ...row, retained: reason });
      this.records.saveOperation({
        ...operation,
        state: 'failed',
        finishedAt: now(),
        error: error instanceof AppError ? error.code : 'GIT_OPERATION_FAILED',
      });
      this.notifySessions(row.id);
    });
  }

  async archive(session: Session) {
    const row = this.records.forSession(session.id);
    if (row?.mode !== 'linked' || !this.allArchived(row)) return this.sessionWorkspace(session);
    const project = this.store.get('projects', session.projectId);
    const workspace = await this.state(project, row);
    if (workspace.state !== 'ready') return workspace;
    try {
      return await this.reclaim(project, row.id, randomUUID());
    } catch (error) {
      // The archive is already committed. A race or filesystem error must retain the checkout.
      const current = this.records.byId(row.id);
      if (
        current?.directoryIdentity === row.directoryIdentity &&
        !current.retained &&
        !this.records.pendingOperations().some((operation) => operation.worktreeId === row.id)
      )
        this.records.saveWorktree({ ...current, retained: retentionReason(error) });
      return this.sessionWorkspace(session);
    }
  }

  async markRebuildable(project: Project, id: string, path: string, mark: boolean) {
    const row = this.owned(project, id);
    const source = await openWorktreeRepository(project, row);
    const targetPath = this.path(project, row);
    return this.exclusive(source, targetPath, async () => {
      const { git } = await checkWorktreeCheckout(row, targetPath);
      const status = await readGitStatus(git);
      if (mark && !status.ignored.includes(path))
        throw gitError('FILE_CHANGED', '此路径当前不在 Git 忽略文件列表中。');
      const rebuildable = mark
        ? [...new Set([...row.rebuildable, path])]
        : row.rebuildable.filter((entry) => entry !== path);
      this.records.saveWorktree({ ...row, rebuildable });
      return { rebuildable };
    });
  }

  async reclaim(project: Project, id: string, requestId: string) {
    return reclaimWorktree(this.lifecycleContext(), project, id, requestId);
  }

  async restore(session: Session, input: GitRestoreRequest) {
    return restoreWorktree(this.lifecycleContext(), session, input);
  }

  async recover() {
    return recoverWorktrees(this.lifecycleContext());
  }
}
