/**
 * @file 管理文件和工具操作的审批。
 * @implementation 按运行策略裁决并记录审批，在允许和执行前核验所选工作树、文件基线和取消状态。
 * @updated 2026-11-24T03:39:03+08:00
 */
import { randomUUID } from 'node:crypto';
import { AppError, activeStatuses, now, type Permission, type Run } from '../shared/types.js';
import { Store } from './store.js';
import { fingerprint, readProjectText, textDiff } from './files.js';

export interface RequestedOperation {
  toolCallId: string;
  kind: Permission['kind'];
  path?: string;
  command?: string;
  before?: string | null;
  after?: string | null;
  reason: string;
}
async function fileBaselineIssue(
  permission: Permission,
  root: string,
): Promise<string | undefined> {
  if (!permission.path) return undefined;
  try {
    if ((await readProjectText(root, permission.path)) !== permission.before)
      return '文件内容已变化，旧差异没有应用。请重新生成修改。';
  } catch (error) {
    if (!(
      error instanceof AppError &&
      error.code === 'FILE_UNAVAILABLE' &&
      permission.before === null
    ))
      return '文件访问状态已变化，请重新生成修改。';
  }
}

export class PermissionService {
  private readonly pending = new Map<
    string,
    { finish: (allowed: boolean) => void; signal: AbortSignal; root: string }
  >();
  constructor(
    private readonly store: Store,
    private readonly ttlMs = 120000,
    private readonly verifyWorkspace?: (run: Run) => Promise<void>,
  ) {}
  async request(
    run: Run,
    root: string,
    operation: RequestedOperation,
    signal: AbortSignal,
  ): Promise<Permission> {
    if (run.workspacePath) await this.verifyWorkspace?.(run);
    signal.throwIfAborted();
    const current = this.store.get('runs', run.id);
    if (!activeStatuses.includes(current.status) || current.status === 'stopping')
      throw new AppError('RUN_STOPPED', '运行已停止。', 409);
    const before = operation.before ?? null,
      after = operation.after ?? null;
    const permission: Permission = {
      id: randomUUID(),
      runId: run.id,
      sessionId: run.sessionId,
      toolCallId: operation.toolCallId,
      subagentId: this.store.get('tools', operation.toolCallId).subagentId,
      kind: operation.kind,
      path: operation.path ?? null,
      command: operation.command ?? null,
      before,
      after,
      diff:
        operation.kind === 'command' || operation.kind === 'mcp' || operation.kind === 'browser'
          ? operation.command!
          : textDiff(operation.path!, before, after),
      baseFingerprint: before === null ? null : fingerprint(before),
      version: randomUUID(),
      status: 'pending',
      createdAt: now(),
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
      reason: operation.reason,
    };
    if (current.approvalMode === 'automatic' && current.mode === 'edit' && !current.retryOf) {
      const staleReason = permission.path ? await fileBaselineIssue(permission, root) : undefined;
      signal.throwIfAborted();
      const latest = this.store.get('runs', run.id);
      if (!activeStatuses.includes(latest.status) || latest.status === 'stopping')
        throw new AppError('RUN_STOPPED', '运行已停止。', 409);
      const resolved = this.store.transaction(() => {
        const saved = this.store.put('permissions', {
          ...permission,
          decisionSource: 'automatic',
          status: staleReason ? 'denied' : 'allowed',
          resolutionReason: staleReason ?? '本轮已开启全工具自动化。',
        });
        this.store.update('tools', operation.toolCallId, { permissionId: saved.id });
        return saved;
      });
      this.store.event(run.id, run.sessionId, 'permission.resolved', {
        permissionId: resolved.id,
        status: resolved.status,
        decisionSource: 'automatic',
      });
      if (staleReason) throw new AppError('OPERATION_CHANGED', staleReason, 409);
      return resolved;
    }
    this.store.put('permissions', permission);
    this.store.update('tools', operation.toolCallId, {
      status: 'awaiting_permission',
      permissionId: permission.id,
    });
    this.store.update('runs', run.id, { status: 'awaiting_permission' });
    const allowed = await new Promise<boolean>((resolve) => {
      const onAbort = () => this.finish(permission.id, 'canceled', '运行停止，审批已取消。');
      const timer = setTimeout(
        () => this.finish(permission.id, 'expired', '审批已超时，请重新发起操作。'),
        this.ttlMs,
      );
      this.pending.set(permission.id, {
        root,
        signal,
        finish: (value) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
      });
      signal.addEventListener('abort', onAbort, { once: true });
      this.store.event(run.id, run.sessionId, 'permission.requested', {
        permissionId: permission.id,
      });
      if (signal.aborted) onAbort();
    });
    signal.throwIfAborted();
    if (!allowed)
      throw new AppError(
        'PERMISSION_DENIED',
        '此操作被拒绝、过期或取消；不要使用其他工具重试同一操作。',
        403,
      );
    if (run.workspacePath) await this.verifyWorkspace?.(run);
    signal.throwIfAborted();
    return this.store.get('permissions', permission.id);
  }
  private finish(id: string, status: Permission['status'], reason?: string): Permission {
    const permission = this.store.get('permissions', id);
    if (permission.status !== 'pending') return permission;
    const updated = this.store.update('permissions', id, {
      status,
      ...(reason ? { resolutionReason: reason } : {}),
    });
    const pending = this.pending.get(id);
    this.pending.delete(id);
    this.store.update('tools', permission.toolCallId, {
      status: status === 'allowed' ? 'running' : status === 'canceled' ? 'canceled' : 'denied',
      ...(status === 'allowed' ? {} : { endedAt: now() }),
    });
    const run = this.store.get('runs', permission.runId);
    if (
      run.status === 'awaiting_permission' &&
      !this.store.list('permissions').some((p) => p.runId === run.id && p.status === 'pending')
    )
      this.store.update('runs', run.id, { status: 'running' });
    this.store.event(permission.runId, permission.sessionId, 'permission.resolved', {
      permissionId: id,
      status,
    });
    pending?.finish(status === 'allowed');
    return updated;
  }
  async decide(id: string, decision: 'allow' | 'deny', version: string): Promise<Permission> {
    const permission = this.store.get('permissions', id);
    if (permission.version !== version)
      throw new AppError('PERMISSION_CHANGED', '审批版本不匹配，请刷新。', 409);
    const desired = decision === 'allow' ? 'allowed' : 'denied';
    if (permission.status === desired) return permission;
    if (permission.status !== 'pending')
      throw new AppError('PERMISSION_EXPIRED', '审批已处理、过期或取消。', 409);
    const pending = this.pending.get(id);
    const run = this.store.get('runs', permission.runId);
    if (
      !pending ||
      pending.signal.aborted ||
      !['running', 'awaiting_permission'].includes(run.status)
    ) {
      this.finish(id, 'canceled');
      throw new AppError('RUN_STOPPED', '运行不再等待此审批。', 409);
    }
    if (Date.now() >= Date.parse(permission.expiresAt)) {
      this.finish(id, 'expired');
      throw new AppError('PERMISSION_EXPIRED', '审批已过期。', 409);
    }
    let staleReason =
      decision === 'allow' && permission.path
        ? await fileBaselineIssue(permission, pending.root)
        : undefined;
    if (decision === 'allow' && run.workspacePath && !staleReason) {
      try {
        await this.verifyWorkspace?.(run);
      } catch {
        staleReason = '工作树已变化，请重新发起此操作。';
      }
    }
    // File checks yield to stop and competing decisions: re-check after every await.
    const latest = this.store.get('permissions', id);
    if (
      pending.signal.aborted ||
      latest.status !== 'pending' ||
      this.store.get('runs', run.id).status === 'stopping'
    ) {
      if (latest.status === desired) return latest;
      throw new AppError('PERMISSION_EXPIRED', '审批状态已变化，决定未重复应用。', 409);
    }
    if (Date.now() >= Date.parse(latest.expiresAt)) {
      this.finish(id, 'expired', '审批已超时，请重新发起操作。');
      throw new AppError('PERMISSION_EXPIRED', '审批已过期。', 409);
    }
    if (staleReason) {
      this.finish(id, 'denied', staleReason);
      throw new AppError('OPERATION_CHANGED', staleReason, 409);
    }
    return this.finish(id, desired);
  }
  cancelRun(id: string): void {
    for (const permission of this.store
      .list('permissions')
      .filter((p) => p.runId === id && p.status === 'pending'))
      this.finish(permission.id, 'canceled', '运行已停止或结束。');
  }
}
