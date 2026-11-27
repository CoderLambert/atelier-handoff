/**
 * @file 绑定运行启动、消息队列和快照所需的执行状态。
 * @implementation 注入统一唤醒和事件通知，连接启动、实时插入、调度与队列读模型而不接触 HTTP。
 * @updated 2026-11-26T23:20:03+08:00
 */
import type { Run, Session } from '../../shared/types.js';
import type { Runner } from '../agent.js';
import type { AgentProfiles } from '../agent-profiles.js';
import type { FileRecords } from '../artifacts.js';
import type { DesktopBrowserAccess } from '../desktop-browser-access.js';
import type { ProjectExtensions } from '../extensions.js';
import type { MessageQueue } from '../message-queue.js';
import type { GatewayService } from '../modules/gateway/service.js';
import type { DevelopmentWorktrees } from '../modules/git/development-worktrees.js';
import { createQueueActions } from '../modules/message-queue/actions.js';
import { createLiveInsertion } from '../modules/message-queue/live-insertion.js';
import { createQueueScheduler } from '../modules/message-queue/scheduler.js';
import { createRunStarter } from '../modules/runs/create-run.js';
import type { createExecutionSlots } from '../modules/runs/execution-slots.js';
import type { SkillScope } from '../modules/skills/scope.js';
import type { SkillInheritance } from '../skill-inheritance.js';
import type { Store } from '../store.js';

export function createMessageRuntime({
  store,
  worktrees,
  files,
  agents,
  extensions,
  inheritance,
  skills,
  browserAccess,
  runner,
  gateway,
  messageQueue,
  execution,
  nativeExecution,
  hasRunnerFactory,
  sessionDirectory,
  isSessionDeleting,
  isShuttingDown,
  wakeQueue,
}: {
  store: Pick<
    Store,
    | 'get'
    | 'list'
    | 'update'
    | 'put'
    | 'event'
    | 'events'
    | 'transaction'
    | 'gitWorktrees'
    | 'runReceipts'
    | 'skillInheritance'
  >;
  worktrees: Pick<DevelopmentWorktrees, 'directory' | 'resolveSession' | 'assertUnlocked'>;
  files: Pick<FileRecords, 'attachmentFile' | 'attachmentContent'>;
  agents: Pick<AgentProfiles, 'requireReady'>;
  extensions: ProjectExtensions;
  inheritance: Pick<SkillInheritance, 'snapshot'>;
  skills: SkillScope;
  browserAccess: Pick<DesktopBrowserAccess, 'read'>;
  runner: Runner;
  gateway: Pick<
    GatewayService,
    'effectiveConfig' | 'connection' | 'magpie' | 'requireMagpieEnabled'
  >;
  messageQueue: MessageQueue;
  execution: Pick<
    ReturnType<typeof createExecutionSlots>,
    'sameSessionRunning' | 'assertExecutionSlot'
  >;
  nativeExecution: boolean;
  hasRunnerFactory: boolean;
  sessionDirectory(session: Session): string;
  isSessionDeleting(id: string): boolean;
  isShuttingDown(): boolean;
  wakeQueue(): void;
}) {
  const queueChanged = (id: string) => {
    store.event('session-' + id, id, 'session.queue_changed');
  };
  const liveInsertion = createLiveInsertion({
    store,
    gateway,
    runner,
    messageQueue,
    skills,
    nativeExecution,
    queueChanged,
    wakeQueue,
  });
  const createRun = createRunStarter({
    store,
    worktrees,
    files,
    agents,
    extensions,
    inheritance,
    skills,
    browserAccess,
    runner,
    gateway,
    messageQueue,
    nativeExecution,
    probeGateway: !hasRunnerFactory,
    isShuttingDown,
    isSessionDeleting,
    sameSessionRunning: execution.sameSessionRunning,
    assertExecutionSlot: execution.assertExecutionSlot,
    insertionAction: liveInsertion.insertionAction,
    queueChanged,
    wakeQueue,
  });
  const queueScheduler = createQueueScheduler({
    store,
    messageQueue,
    runner,
    liveInsertion,
    sessionDirectory,
    createRun,
    queueChanged,
    assertExecutionSlot: execution.assertExecutionSlot,
    isShuttingDown,
    listenForRunEvents: hasRunnerFactory,
  });
  const queue = createQueueActions({
    store,
    messageQueue,
    runner,
    liveInsertion,
    worktrees,
    createRun,
    queueChanged,
    wakeQueue,
  });
  function readQueue(sessionId: string, active: Run | undefined) {
    let config: ReturnType<typeof gateway.effectiveConfig> | undefined;
    return messageQueue.snapshot(sessionId, (item) =>
      active
        ? liveInsertion.insertionAction(item, active, (config ??= gateway.effectiveConfig()))
        : undefined,
    );
  }
  return { createRun, queue, queueScheduler, readQueue };
}
