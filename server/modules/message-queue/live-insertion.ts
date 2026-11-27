/**
 * @file 判定已排队消息的实时插入兼容性并跟踪回执。
 * @implementation 对照冻结配置和当前工具范围；保持原 native runner 插入、派发、确认和失败释放回调。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { AppError, type AppConfig, type Run } from '../../../shared/types.js';
import type { Runner } from '../../agent.js';
import { magpieModel } from '../../magpie-models.js';
import type { MessageQueue, PendingSessionMessage } from '../../message-queue.js';
import type { Store } from '../../store.js';
import type { GatewayService } from '../gateway/service.js';
import { queuedIntent } from '../runs/message-input.js';
import type { SkillScope } from '../skills/scope.js';

export function createLiveInsertion({
  store,
  gateway,
  runner,
  messageQueue,
  skills,
  nativeExecution,
  queueChanged,
  wakeQueue,
}: {
  store: Pick<Store, 'get' | 'skillInheritance'>;
  gateway: Pick<GatewayService, 'effectiveConfig' | 'magpie'>;
  runner: Pick<Runner, 'insert' | 'canInsertNow' | 'hasLiveInputSlot'>;
  messageQueue: Pick<MessageQueue, 'beginLive' | 'dispatched' | 'confirmLive' | 'releaseLive'>;
  skills: SkillScope;
  nativeExecution: boolean;
  queueChanged(id: string): void;
  wakeQueue(): void;
}) {
  const { effectiveConfig, magpie } = gateway;
  function insertionMode(
    item: PendingSessionMessage,
    run: Run,
    current: AppConfig = effectiveConfig(),
  ) {
    const parsed = queuedIntent.safeParse(item.intent);
    if (!parsed.success) return undefined;
    const { request, model, scope, skillScope, executor = 'project-v1' } = parsed.data;
    if (executor === 'native-v1' && !nativeExecution) return undefined;
    const usesMagpie = magpieModel(model) !== undefined;
    if (usesMagpie && current.magpieEnabled !== true) return undefined;
    const compatible =
      Boolean(runner.insert) &&
      scope === run.inputScope &&
      executor === (run.executor ?? 'project-v1') &&
      model === run.config.model &&
      request.mode === run.mode &&
      request.effort === run.config.effort &&
      request.approvalMode === run.approvalMode &&
      request.maxSearchChargeFen === run.maxSearchChargeFen &&
      (usesMagpie ? magpie : current.gateway) === run.config.gateway &&
      current.limitExecution === run.config.limitExecution &&
      current.maxTurns === run.config.maxTurns &&
      current.timeoutMs === run.config.timeoutMs &&
      !request.contextPaths.length &&
      !request.attachmentIds.length &&
      !request.extensionSelections.length &&
      !/^\s*[/!]/u.test(request.text);
    if (!compatible || runner.canInsertNow?.(run.id) === false) return 'priority';
    const session = store.get('sessions', run.sessionId);
    const workspaceAutomatic =
      executor === 'project-v1' &&
      request.mode === 'edit' &&
      request.approvalMode === 'automatic' &&
      !session.agentRevisionId;
    if (!skillScope) {
      // Legacy intents cannot be inserted into a scope that now admits project directory Skills.
      const restricted = [...store.skillInheritance.sessionModes(session.id).values()].some(
        (mode) => mode !== 'follow',
      );
      return executor === 'project-v1' && !workspaceAutomatic && !restricted ? 'live' : 'priority';
    }
    return skillScope ===
      skills.automatic(
        skills.context(
          run.projectId,
          session,
          executor === 'native-v1',
          run.workspacePath,
          workspaceAutomatic,
        ),
      )
      ? 'live'
      : 'priority';
  }
  function insertionAction(item: PendingSessionMessage, run: Run, current?: AppConfig) {
    const mode = insertionMode(item, run, current);
    return mode === 'live' && runner.hasLiveInputSlot?.(run.id) === false ? undefined : mode;
  }
  async function insertLive(item: PendingSessionMessage, run: Run, priority: 'next' | 'now') {
    const intent = queuedIntent.parse(item.intent);
    const { id: runId, sessionId } = run;
    messageQueue.beginLive(item, runId);
    try {
      if (!runner.insert)
        throw new AppError('LIVE_INPUT_UNAVAILABLE', '当前运行无法插入消息。', 409);
      await runner.insert(runId, {
        id: item.id,
        text: intent.request.text,
        priority,
        canDispatch: () => {
          const current = store.get('runs', runId);
          return (
            ['running', 'awaiting_permission'].includes(current.status) &&
            insertionMode(item, current) === 'live'
          );
        },
        dispatched() {
          messageQueue.dispatched(item, runId);
          queueChanged(sessionId);
        },
        confirmed() {
          messageQueue.confirmLive(item, runId);
          queueChanged(sessionId);
          wakeQueue();
        },
        released() {
          messageQueue.releaseLive(item, runId);
          queueChanged(sessionId);
        },
      });
    } catch (error) {
      messageQueue.releaseLive(item, runId);
      queueChanged(sessionId);
      throw error;
    }
    queueChanged(sessionId);
  }
  return { insertionMode, insertionAction, insertLive };
}

export type LiveInsertion = ReturnType<typeof createLiveInsertion>;
