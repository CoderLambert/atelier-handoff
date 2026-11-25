/**
 * @file 绑定开发会话与实际 Git 工作目录。
 * @implementation 验证归属、目录身份与分支，以操作回执协调 SQLite 和系统 Git；为终端独立预留目录，阻止占用期间回收而不长期持有 Git 写租约。
 * @updated 2026-11-26T04:17:21+08:00
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
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
import {
  AppError,
  emptyDraft,
  now,
  type Project,
  type Run,
  type Session,
} from '../../../shared/types.js';
import { fingerprint, inside, resolveProjectPath } from '../../files.js';
import type { Store } from '../../store.js';
import { fileIdentity, gitError, LocalGit } from './git-cli.js';
import { listGitWorktrees, readGitOverview, readGitStatus } from './git-reader.js';
import { captureCheckout, WorktreeSnapshots } from './worktree-snapshots.js';
import type { WorktreeOperation, WorktreeRecord } from './worktree-repository.js';

export const directoriesOverlap = (a: string, b: string) => inside(a, b) || inside(b, a);

export async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function assertIdleGit(git: LocalGit, ownIndexLock = false) {
  const markers = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'REBASE_HEAD',
    'BISECT_START',
    'rebase-apply',
    'rebase-merge',
    'sequencer',
    ...(ownIndexLock ? [] : ['index.lock']),
  ];
  if ((await Promise.all(markers.map((name) => pathExists(join(git.admin, name))))).some(Boolean))
    throw gitError('IN_PROGRESS', '此检出有进行中的 Git 操作。');
}

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
  private readonly leases = new Map<string, string>();
  private readonly terminalReservations = new Map<symbol, string>();

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
    return row.mode === 'linked' ? join(this.managed, row.id) : project.path;
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
    this.assertUnlocked(path);
    const token = Symbol('terminal');
    this.terminalReservations.set(token, path);
    const release = () => {
      this.terminalReservations.delete(token);
    };
    const assertSpawnAllowed = () => {
      const current = this.store.get('sessions', session.id);
      if (
        !this.terminalReservations.has(token) ||
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
      release,
      resolve: async () => {
        try {
          assertSpawnAllowed();
          const resolved = await this.resolveSession(this.store.get('sessions', session.id));
          assertSpawnAllowed();
          if (resolved !== path) throw gitError('WORKTREE_CHANGED', '终端的工作目录已变化。');
          return resolved;
        } catch (error) {
          release();
          throw error;
        }
      },
    };
  }

  private terminalRetains(path: string): boolean {
    return [...this.terminalReservations.values()].some((other) => directoriesOverlap(path, other));
  }

  assertUnlocked(path: string) {
    if ([...this.leases.values()].some((other) => directoriesOverlap(path, other)))
      throw gitError('DIRECTORY_BUSY', '工作目录正在处理 Git 操作。');
  }

  private async exclusive<T>(git: LocalGit, path: string, work: () => Promise<T>) {
    this.assertUnlocked(path);
    if (this.leases.has(git.repositoryId))
      throw gitError('DIRECTORY_BUSY', '同一仓库的另一项 Git 操作正在进行。');
    this.leases.set(git.repositoryId, path);
    try {
      return await work();
    } finally {
      this.leases.delete(git.repositoryId);
      this.dependencies.released();
    }
  }

  private async checkManaged(path: string) {
    if (this.store.list('projects').some((project) => directoriesOverlap(path, project.path)))
      throw gitError('DIRECTORY_OVERLAP', '受管工作树位置与已授权项目目录重叠。');
    await mkdir(this.managed, { recursive: true, mode: 0o700 });
    await fileIdentity(this.managed);
  }

  private async checkCheckout(
    project: Project,
    row: WorktreeRecord,
    signal?: AbortSignal,
    path = this.path(project, row),
  ) {
    const git = await LocalGit.open(path, signal);
    if (
      git.repositoryId !== row.repositoryId ||
      (row.mode === 'linked' &&
        (git.admin === git.common || !inside(join(git.common, 'worktrees'), git.admin)))
    )
      throw gitError('WORKTREE_CHANGED', '检出的仓库身份已变化。');
    const [entry, identity, admin] = await Promise.all([
      listGitWorktrees(git, signal).then((trees) => trees.find((item) => item.path === path)),
      fileIdentity(path),
      fileIdentity(git.admin),
    ]);
    if (
      !entry ||
      entry.missing ||
      entry.branch !== row.branch ||
      (row.directoryIdentity && row.directoryIdentity !== identity) ||
      (row.adminIdentity && row.adminIdentity !== admin)
    )
      throw gitError('WORKTREE_CHANGED', '工作树位置或分支已变化。');
    return { git, entry, identity, admin };
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
    if ([...this.leases.values()].some((other) => directoriesOverlap(path, other)))
      return { ...common, state: 'busy' };
    if (row.retained === 'relocated' && row.snapshotId) {
      const retainedPath = this.scratch('reclaim', row.snapshotId);
      if (await pathExists(retainedPath)) return { ...common, state: 'changed', retainedPath };
    }
    if (!(await pathExists(path))) {
      if (!row.snapshotId) return { ...common, state: 'missing' };
      const saved = this.records.operation(row.snapshotId);
      const needsBranch = saved
        ? await this.repository(project, row)
            .then((git) => this.needsBranch(git, saved.branch, saved.oid))
            .catch(() => false)
        : false;
      return { ...common, state: 'snapshotted', ...(needsBranch ? { needsBranch } : {}) };
    }
    if (!row.directoryIdentity) return { ...common, state: 'changed' };
    try {
      await this.checkCheckout(project, row);
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
      await this.checkCheckout(project, row);
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
          !this.terminalRetains(state.path),
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
    this.assertUnlocked(this.path(project, row));
    if (!row.directoryIdentity || !(await pathExists(this.path(project, row))))
      throw gitError('WORKTREE_MISSING', '此工作树当前不可用。', 404);
    return {
      git: (await this.checkCheckout(project, row, signal)).git,
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
    const { git, entry, identity, admin } = await this.checkCheckout(project, row);
    if (entry.head !== operation.oid || (await readGitStatus(git, undefined, false)).files.length)
      throw gitError('WORKTREE_CHANGED', '新检出与预览基线不一致。');
    return this.finishCreate(project, row, operation, identity, admin);
  }

  async create(project: Project, input: DevelopmentCreate) {
    const requestHash = fingerprint(JSON.stringify([project.id, 'create', input]));
    const previous = () => this.result(this.records.operation(input.requestId), requestHash);
    const replay = previous();
    if (replay?.sessionId) return this.store.get('sessions', replay.sessionId);
    const git = await LocalGit.open(project.path);
    const path = input.mode === 'linked' ? join(this.managed, input.requestId) : project.path;
    return this.exclusive(git, path, async () => {
      const replay = previous();
      if (replay?.sessionId) return this.store.get('sessions', replay.sessionId);
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
    });
  }

  private scratch(purpose: 'verify' | 'restore' | 'reclaim', id: string) {
    return join(this.managed, '.' + purpose + '-' + id);
  }

  private async repository(project: Project, row: WorktreeRecord) {
    const git = await LocalGit.open(project.path);
    if (git.repositoryId !== row.repositoryId)
      throw gitError('WORKTREE_CHANGED', '项目的 Git 仓库身份已变化。');
    return git;
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

  private async scratchCheckout(git: LocalGit, path: string, oid: string) {
    await this.checkManaged(path);
    if (await pathExists(path)) throw gitError('DESTINATION_EXISTS', '临时检出目录已存在。');
    await git.run(['worktree', 'add', '--detach', '--', path, oid]);
    return LocalGit.open(path);
  }

  // Scratch paths belong to one persisted operation and are outside all project roots.
  private async discardScratch(git: LocalGit, path: string, identity: string | null) {
    if (!identity || !(await pathExists(path)) || (await fileIdentity(path)) !== identity) return;
    const scratch = await LocalGit.open(path).catch(() => undefined);
    if (scratch?.repositoryId !== git.repositoryId) return;
    await git.run(['worktree', 'remove', '--force', '--', path]);
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
        this.records.saveWorktree({ ...current, retained: this.retentionReason(error) });
      return this.sessionWorkspace(session);
    }
  }

  async markRebuildable(project: Project, id: string, path: string, mark: boolean) {
    const row = this.owned(project, id);
    const source = await this.repository(project, row);
    return this.exclusive(source, this.path(project, row), async () => {
      const { git } = await this.checkCheckout(project, row);
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
    const existing = this.owned(project, id);
    const requestHash = fingerprint(JSON.stringify([project.id, 'reclaim', id]));
    const replay = this.records.operation(requestId);
    if (replay) {
      if (replay.requestHash !== requestHash || replay.state === 'pending')
        this.result(replay, requestHash);
      return this.state(project, existing);
    }
    const source = await this.repository(project, existing);
    const path = this.path(project, existing);
    await this.exclusive(source, path, async () => {
      const repeated = this.records.operation(requestId);
      if (repeated) {
        if (repeated.requestHash !== requestHash || repeated.state === 'pending')
          this.result(repeated, requestHash);
        return;
      }
      if (this.terminalRetains(path))
        throw gitError('DIRECTORY_BUSY', '工作目录仍有未结束的终端。');
      let row = this.owned(project, id);
      if (row.retained === 'relocated' || !row.directoryIdentity || !this.allArchived(row))
        throw gitError('DIRECTORY_BUSY', '所有关联会话均归档后才能回收工作树。');
      await this.checkManaged(path);
      const { git, entry } = await this.checkCheckout(project, row);
      if (!entry.head) throw gitError('BASE_MISSING', '工作树没有可保存的基线提交。');
      let operation: WorktreeOperation = {
        id: requestId,
        worktreeId: id,
        requestHash,
        kind: 'reclaim',
        state: 'pending',
        sessionId: null,
        branch: row.branch,
        oid: entry.head,
        createdAt: now(),
        finishedAt: null,
        scratchIdentity: null,
        error: null,
      };
      this.records.saveOperation(operation);
      const verifyPath = this.scratch('verify', operation.id);
      const quarantine = this.scratch('reclaim', operation.id);
      let moved = false;
      try {
        if (entry.locked || this.dependencies.inUse(path))
          throw gitError('DIRECTORY_BUSY', '工作树已锁定或有待处理的任务。');
        await assertIdleGit(git);
        await this.dependencies.closeDirectory(path);
        const capture = await captureCheckout(git, row.branch, row.rebuildable);
        if (capture.manifest.oid !== operation.oid)
          throw gitError('WORKTREE_CHANGED', '工作树基线在保存期间变化。');
        const snapshotDigest = await this.snapshots.save(operation.id, capture);
        const manifest = await this.snapshots.manifest(operation.id, snapshotDigest);
        const verification = await this.scratchCheckout(source, verifyPath, operation.oid);
        operation = { ...operation, scratchIdentity: await fileIdentity(verifyPath) };
        this.records.saveOperation(operation);
        try {
          await this.snapshots.apply(operation.id, verification, manifest);
          await this.snapshots.verify(verification, manifest);
        } finally {
          await this.discardScratch(source, verifyPath, operation.scratchIdentity);
        }
        // Keep the base reachable even if the original branch is later reset or deleted.
        await source.run(['update-ref', 'refs/atelier/snapshots/' + operation.id, operation.oid]);
        await this.snapshots.verify(
          (await this.checkCheckout(project, row)).git,
          manifest,
          row.rebuildable,
        );
        if (await pathExists(quarantine))
          throw gitError('DESTINATION_EXISTS', '回收暂存目录已存在。');
        row = { ...row, snapshotId: operation.id, snapshotDigest };
        this.records.saveWorktree(row);
        await source.run(['worktree', 'move', '--', path, quarantine]);
        moved = true;
        const parked = await this.checkCheckout(project, row, undefined, quarantine);
        await this.snapshots.verify(parked.git, manifest, row.rebuildable);
        await assertIdleGit((await this.checkCheckout(project, row, undefined, quarantine)).git);
        // Destructive removal only targets the private, verified directory.
        await source.run(['worktree', 'remove', '--force', '--', quarantine]);
        this.store.transaction(() =>
          this.finish(
            { ...row, directoryIdentity: null, adminIdentity: null, retained: null },
            operation,
          ),
        );
      } catch (error) {
        const parked = moved || (row.snapshotId === operation.id && (await pathExists(quarantine)));
        let reason = this.retentionReason(error);
        if (parked) {
          if (
            !(await pathExists(quarantine)) &&
            !(await pathExists(path)) &&
            row.snapshotId === operation.id
          ) {
            this.store.transaction(() =>
              this.finish(
                { ...row, directoryIdentity: null, adminIdentity: null, retained: null },
                operation,
              ),
            );
            return;
          }
          const recovered = await this.returnParked(project, source, row, quarantine);
          if (!recovered) reason = 'relocated';
        }
        const retained =
          reason === 'relocated' ? row : { ...row, snapshotId: null, snapshotDigest: null };
        this.fail(retained, operation, error, reason);
      }
    });
    return this.state(project, this.owned(project, id));
  }

  private retentionReason(error: unknown): GitRetentionReason {
    const code = error instanceof AppError ? error.code : undefined;
    if (code === 'GIT_IGNORED_FILES') return 'ignored';
    if (code === 'GIT_DIRECTORY_BUSY') return 'inUse';
    if (code === 'GIT_WORKTREE_CHANGED' || code === 'GIT_DESTINATION_EXISTS') return 'changed';
    if (
      code === 'GIT_IN_PROGRESS' ||
      code === 'GIT_SNAPSHOT_UNSUPPORTED' ||
      code === 'GIT_OUTPUT_LIMIT'
    )
      return 'unsupported';
    return 'snapshotFailed';
  }

  private async returnParked(
    project: Project,
    source: LocalGit,
    row: WorktreeRecord,
    parked: string,
  ) {
    const original = this.path(project, row);
    try {
      if (await pathExists(original)) return false;
      await this.checkCheckout(project, row, undefined, parked);
      await source.run(['worktree', 'move', '--', parked, original]);
      return true;
    } catch {
      return false;
    }
  }

  private async needsBranch(git: LocalGit, branch: string, oid: string) {
    const [ref, worktrees] = await Promise.all([
      git.oid('refs/heads/' + branch),
      listGitWorktrees(git),
    ]);
    return ref !== oid || worktrees.some((entry) => entry.branch === branch);
  }

  async restore(session: Session, input: GitRestoreRequest) {
    const row = this.records.forSession(session.id);
    if (!row || row.mode !== 'linked')
      throw gitError('WORKTREE_MISSING', '此会话没有可恢复的工作树。', 404);
    const project = this.store.get('projects', session.projectId);
    const requestHash = fingerprint(
      JSON.stringify([project.id, 'restore', session.id, input.branch]),
    );
    const previous = () => this.result(this.records.operation(input.requestId), requestHash);
    if (previous()) return this.store.get('sessions', session.id);
    const source = await this.repository(project, row);
    const path = this.path(project, row);
    return this.exclusive(source, path, async () => {
      if (previous()) return this.store.get('sessions', session.id);
      const current = this.owned(project, row.id);
      if (
        !current.snapshotId ||
        !current.snapshotDigest ||
        current.retained === 'relocated' ||
        (await pathExists(path))
      )
        throw gitError('RESTORE_UNAVAILABLE', '原目录已存在或没有可用的工作树快照。');
      await this.checkManaged(path);
      const manifest = await this.snapshots.manifest(current.snapshotId, current.snapshotDigest);
      const pin = await source.oid('refs/atelier/snapshots/' + current.snapshotId);
      if (pin !== manifest.oid) throw gitError('SNAPSHOT_CORRUPT', '快照基线不可用或校验失败。');
      if (
        (!input.branch || input.branch === manifest.branch) &&
        (await this.needsBranch(source, manifest.branch, manifest.oid))
      )
        throw gitError('RESTORE_BRANCH_REQUIRED', '原分支已移动或被占用，请确认一个新分支名。');
      const branch = input.branch ?? manifest.branch;
      if (branch !== manifest.branch) await source.checkNewBranch(branch);
      let operation: WorktreeOperation = {
        id: input.requestId,
        worktreeId: row.id,
        requestHash,
        kind: 'restore',
        state: 'pending',
        sessionId: session.id,
        branch,
        oid: manifest.oid,
        createdAt: now(),
        finishedAt: null,
        scratchIdentity: null,
        error: null,
      };
      this.records.saveOperation(operation);
      const staging = this.scratch('restore', operation.id);
      try {
        const scratch = await this.scratchCheckout(source, staging, manifest.oid);
        operation = { ...operation, scratchIdentity: await fileIdentity(staging) };
        this.records.saveOperation(operation);
        await this.snapshots.apply(current.snapshotId, scratch, manifest);
        await scratch.run([
          'switch',
          '--no-guess',
          '--no-overwrite-ignore',
          ...(branch === manifest.branch ? [branch] : ['-c', branch]),
        ]);
        await this.snapshots.verify(scratch, manifest);
        if (await pathExists(path)) throw gitError('DESTINATION_EXISTS', '原工作目录已被占用。');
        await source.run(['worktree', 'move', '--', staging, path]);
        return await this.completeRestore(project, current, operation);
      } catch (error) {
        try {
          await this.discardScratch(source, staging, operation.scratchIdentity);
        } catch {
          // Keep a private checkout that cannot be removed by Git.
        }
        this.fail(current, operation, error, 'snapshotFailed');
        throw error;
      }
    });
  }

  private async completeRestore(
    project: Project,
    row: WorktreeRecord,
    operation: WorktreeOperation,
  ) {
    if (!row.snapshotId || !row.snapshotDigest || !operation.sessionId)
      throw gitError('RESTORE_UNAVAILABLE', '恢复记录缺少快照或会话。');
    const restored = {
      ...row,
      branch: operation.branch,
      directoryIdentity: null,
      adminIdentity: null,
    };
    const manifest = await this.snapshots.manifest(row.snapshotId, row.snapshotDigest);
    const { git, entry, identity, admin } = await this.checkCheckout(project, restored);
    if (
      identity !== operation.scratchIdentity ||
      entry.head !== operation.oid ||
      manifest.oid !== operation.oid
    )
      throw gitError('WORKTREE_CHANGED', '恢复目录的基线已变化。');
    await this.snapshots.verify(git, manifest);
    const session = this.store.get('sessions', operation.sessionId);
    return this.store.transaction(() => {
      this.finish(
        {
          ...restored,
          directoryIdentity: identity,
          adminIdentity: admin,
          snapshotId: null,
          snapshotDigest: null,
          retained: null,
        },
        operation,
      );
      const active = this.store.update('sessions', session.id, {
        status: 'active',
        updatedAt: now(),
      });
      this.store.event('session-' + session.id, session.id, 'session.updated', {
        worktreeId: row.id,
      });
      return active;
    });
  }

  private async recoverReclaim(
    project: Project,
    row: WorktreeRecord,
    operation: WorktreeOperation,
  ) {
    const git = await this.repository(project, row);
    await this.discardScratch(git, this.scratch('verify', operation.id), operation.scratchIdentity);
    if (row.snapshotId !== operation.id || !row.snapshotDigest)
      throw gitError('OPERATION_FAILED', '归档在快照验证前中断。');
    const manifest = await this.snapshots.manifest(operation.id, row.snapshotDigest);
    const parked = this.scratch('reclaim', operation.id);
    if (await pathExists(parked)) {
      const returned = await this.returnParked(project, git, row, parked);
      const retained = returned ? { ...row, snapshotId: null, snapshotDigest: null } : row;
      this.fail(
        retained,
        operation,
        gitError('OPERATION_FAILED', '回收被中断，已保留工作目录。'),
        returned ? 'interrupted' : 'relocated',
      );
      return;
    }
    if ((await pathExists(this.path(project, row))) || manifest.oid !== operation.oid)
      throw gitError('OPERATION_FAILED', '回收被中断，已保留工作目录。');
    this.store.transaction(() =>
      this.finish(
        { ...row, directoryIdentity: null, adminIdentity: null, retained: null },
        operation,
      ),
    );
  }

  async recover() {
    for (const operation of this.records.pendingOperations()) {
      const row = this.records.byId(operation.worktreeId);
      if (!row) continue;
      const project = this.store.get('projects', row.projectId);
      try {
        if (operation.kind === 'create') await this.completeCreate(project, row, operation);
        else if (operation.kind === 'reclaim') await this.recoverReclaim(project, row, operation);
        else {
          const git = await this.repository(project, row);
          await this.discardScratch(
            git,
            this.scratch('restore', operation.id),
            operation.scratchIdentity,
          );
          await this.completeRestore(project, row, operation);
        }
      } catch (error) {
        const parked =
          operation.kind === 'reclaim' &&
          row.snapshotId === operation.id &&
          (await pathExists(this.scratch('reclaim', operation.id)).catch(() => false));
        this.fail(row, operation, error, parked ? 'relocated' : 'interrupted');
      }
    }
  }
}
