/**
 * @file 消费 Claude SDK 运行消息流并推进回合、任务与用量状态。
 * @implementation 处理初始化、任务通知、增量流、助手回复、工具结果与终态汇总，将状态变化同步到存储和事件流。
 * @updated 2026-11-27T12:52:00-06:00
 */
import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { BashControl } from '../../../shared/bash-execution.js';
import { AppError, type Run, type ToolCall } from '../../../shared/types.js';
import { sampleContextUsage } from '../../context-usage.js';
import type { BashTaskReceipt, NativeBashTasks } from '../../native-bash.js';
import type { RequestTiming } from '../../request-timing.js';
import type { RunSkill } from '../../run-skills.js';
import type { Store } from '../../store.js';
import type { SubagentRun } from '../../subagent-run.js';
import { readRunUsage } from '../../usage.js';
import { sdkInputIds, type LiveTurnCoordinator } from './live-turn-coordinator.js';
import type { RunTranscriptLedger } from './run-transcript-ledger.js';
import type { SdkTaskCoordinator } from './sdk-task-coordinator.js';

export interface LiveRunControls {
  cancellation: AbortController;
  reason?: 'user' | 'timeout' | 'shutdown';
  stopSubagent?: (id: string) => Promise<void>;
  controlBash?: (toolId: string, action: BashControl['action']) => Promise<void>;
  canInsertNow?: () => boolean;
  canInsertNext?: () => boolean;
}

export interface SdkStreamConsumerDeps {
  connection: ReturnType<typeof query>;
  run: Run;
  sessionId: string;
  configKey: string;
  resumeExisting: boolean;
  initialModel: string;
  initialCost: number | null;
  signal: AbortSignal;
  live: LiveRunControls;
  store: Store;
  turn: LiveTurnCoordinator;
  ledger: RunTranscriptLedger;
  tasks: SdkTaskCoordinator;
  subagents: SubagentRun;
  bash?: NativeBashTasks;
  requestTiming: RequestTiming;
  candidates: Map<string, RunSkill>;
  capturing: Set<string>;
  appToolId: (id: string, agentId?: string) => string;
  finishTool: (
    id: string,
    ok: boolean | 'stopped' | 'unknown',
    output: string,
    bashLog?: ToolCall['bashLog'],
  ) => ToolCall | undefined;
  finishBashTask: (task: BashTaskReceipt) => Promise<void>;
  getAssistantId: () => string;
  setAssistantAnchor: (anchor: string | undefined) => void;
  cleanError: (error: unknown, maxChars?: number) => string;
}

export async function consumeSdkStream(
  deps: SdkStreamConsumerDeps,
): Promise<{ failure: string | null }> {
  const {
    connection,
    run,
    sessionId,
    configKey,
    resumeExisting,
    signal,
    live,
    store,
    turn,
    ledger,
    tasks,
    subagents,
    bash,
    requestTiming,
    candidates,
    capturing,
    appToolId,
    finishTool,
    finishBashTask,
    getAssistantId,
    setAssistantAnchor,
    cleanError,
  } = deps;

  let observedModel = deps.initialModel;
  let previousCost = deps.initialCost;
  let firstText = true;
  let lastHeartbeat = 0;
  let failure: string | null = null;
  let contextSessionId: string | undefined;

  for await (const message of connection) {
    const assistantId = getAssistantId();
    if (message.type === 'system' && message.subtype === 'init') {
      contextSessionId = message.session_id;
      live.stopSubagent = async (id) => {
        if (!live.stopSubagent)
          throw new AppError('SUBAGENT_NOT_ACTIVE', '子任务已结束或尚未就绪。', 409);
        await subagents.stop(connection, id);
      };
      if (bash && !turn.isDrainingInput) {
        live.controlBash = async (id, action) => {
          try {
            await bash.control(connection, id, action);
          } catch (error) {
            const rejected = action === 'stop' ? bash.failureAfterRejectedStop(id) : undefined;
            if (rejected !== undefined) {
              finishTool(id, false, rejected, { status: 'receipt-only' });
              turn.sendInsertion();
              turn.afterDeferredWork();
            }
            throw error;
          }
        };
        live.canInsertNow = () => turn.canInsertNow();
        live.canInsertNext = () => turn.canInsertNext();
      }
      const firstInit = turn.onInitialized(connection);
      observedModel = message.model || observedModel;
      store.update('sessions', sessionId, {
        sdkSessionId: message.session_id,
        sdkMode: run.mode,
        sdkConfigKey: configKey,
        ...(firstInit && !resumeExisting ? { sdkCostTotal: 0 } : {}),
      });
      if (candidates.size) {
        const discovered = new Set(message.skills ?? []);
        const items: Pick<RunSkill, 'id' | 'name' | 'version' | 'source'>[] = [];
        const missing: typeof items = [];
        for (const [key, { id, name, version, source }] of candidates) {
          (discovered.has(key) ? items : missing).push({ id, name, version, source });
        }
        store.event(run.id, sessionId, 'skills.discovered', {
          items,
          missing,
          count: items.length,
          missingCount: missing.length,
        });
      }
      store.event(run.id, sessionId, 'sdk.initialized', {
        model: message.model,
        version: message.claude_code_version,
        tools: message.tools,
        resumed: !!resumeExisting,
      });
    } else if (message.type === 'system' && message.subtype === 'session_state_changed') {
      turn.onSessionStateChanged(message.session_id, message.state);
    } else if (message.type === 'system' && message.subtype === 'task_started') {
      tasks.handleStarted(message);
    } else if (message.type === 'system' && message.subtype === 'task_updated') {
      tasks.handleUpdated(message);
      turn.sendInsertion();
    } else if (message.type === 'system' && message.subtype === 'task_notification') {
      const { subagentFinished, bashReceipt } = tasks.handleNotification(message);
      if (subagentFinished) {
        turn.sendInsertion();
        turn.afterDeferredWork();
      }
      if (bashReceipt && !capturing.has(bashReceipt.id)) {
        await finishBashTask(bashReceipt);
        turn.afterDeferredWork();
      }
    } else if (message.type === 'stream_event') {
      requestTiming.observe(message, Date.now(), performance.now());
      if (message.parent_tool_use_id) continue;
      const event = message.event;
      turn.acknowledgeInsertion(message.session_id, sdkInputIds(message), 'reply');
      ledger.acceptStream(message, assistantId, appToolId);
      if (event.type === 'message_start') turn.onModelStarted();
      if (
        firstText &&
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta' &&
        event.delta.text
      ) {
        firstText = false;
        store.event(run.id, sessionId, 'sdk.first_text', {
          elapsedMs: Date.now() - Date.parse(store.get('runs', run.id).startedAt ?? run.createdAt),
        });
      }
    } else if (
      message.type === 'tool_progress' ||
      (message.type === 'system' && message.subtype === 'task_progress')
    ) {
      // Persist an actual SDK heartbeat at most once per fifteen seconds for this run.
      if (Date.now() - lastHeartbeat >= 15_000) {
        lastHeartbeat = Date.now();
        if (message.type === 'tool_progress' && message.tool_name === 'Bash')
          bash?.progress(message.tool_use_id, message.session_id, message.task_id);
        store.event(
          run.id,
          sessionId,
          'harness.progress',
          message.type === 'tool_progress'
            ? {
                kind: 'running',
                summary: `${message.tool_name} 正在执行（${Math.round(message.elapsed_time_seconds)} 秒）`,
                toolUseId: message.tool_use_id,
              }
            : {
                kind: 'running',
                summary: `子任务正在执行，已调用 ${message.usage.tool_uses} 次工具。`,
                taskId: message.task_id,
              },
        );
      }
    } else if (message.type === 'system' && message.subtype === 'permission_denied') {
      const id = appToolId(message.tool_use_id, message.agent_id);
      if (!message.agent_id) ledger.recordBlockedTool(id, message.tool_name);
      store.event(run.id, sessionId, 'sdk.notice', {
        type: message.type,
        subtype: message.subtype,
      });
    } else if (message.type === 'system' && message.subtype === 'api_retry') {
      store.event(run.id, sessionId, 'sdk.api_retry', {
        ...(live.reason && { afterStopRequested: true }),
        attempt: message.attempt,
        maxRetries: message.max_retries,
        retryDelayMs: message.retry_delay_ms,
        httpStatus: message.error_status,
        error: message.error,
        noResponse: message.no_response,
      });
    } else if (message.type === 'assistant') {
      requestTiming.linkAssistant(message.request_id, message.message.id);
      if (message.parent_tool_use_id || message.agent_id) continue;
      if (!message.error)
        turn.acknowledgeInsertion(message.session_id, sdkInputIds(message), 'reply');
      const owner = ledger.acceptAssistant(message, assistantId, appToolId);
      if (owner === assistantId)
        setAssistantAnchor(
          !message.error && !message.message.content.some((block) => block.type === 'tool_use')
            ? message.uuid
            : undefined,
        );
      const { error } = message;
      if (error) {
        ledger.recordNotice(message.uuid, (position) => ({
          ...position,
          kind: 'api_error',
          code: error,
        }));
        store.event(run.id, sessionId, 'sdk.error', {
          stage: 'assistant',
          code: error,
        });
      }
    } else if (message.type === 'user' && 'isReplay' in message && message.isReplay) {
      if (
        message.parent_tool_use_id === null &&
        !('agent_id' in message && message.agent_id) &&
        !message.isSynthetic
      )
        turn.acknowledgeInsertion(message.session_id, [message.uuid], 'replay');
    } else if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content)
        if (block.type === 'tool_result') {
          const actor = 'agent_id' in message ? message.agent_id : undefined;
          const id = appToolId(block.tool_use_id, actor);
          let record: ToolCall;
          try {
            record = store.get('tools', id);
          } catch {
            // The SDK can reject an unavailable tool before invoking the hook.
            const name = !actor && block.is_error ? ledger.toolPosition(id)?.name : undefined;
            if (name) {
              ledger.recordBlockedTool(id, name);
              store.event(run.id, sessionId, 'tool.blocked', {
                toolCallId: id,
                tool: name,
                code: null,
              });
            }
            continue;
          }
          if (
            record.status === 'running' &&
            record.name !== 'Agent' &&
            !capturing.has(id) &&
            !bash?.awaitingTerminal(id)
          )
            finishTool(
              id,
              !block.is_error,
              typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            );
        }
    } else if (message.type === 'result') {
      const continuingInsertion = turn.onFinalResult(message);
      for (const denied of message.permission_denials) {
        const id = appToolId(denied.tool_use_id);
        if (ledger.toolPosition(id)?.name) ledger.recordBlockedTool(id, denied.tool_name);
      }
      if (!continuingInsertion && message.subtype === 'success')
        ledger.fallback(assistantId, message.result);
      const { usage, cumulativeCost } = readRunUsage(message, observedModel, previousCost);
      previousCost = cumulativeCost ?? previousCost;
      store.update('sessions', sessionId, { sdkCostTotal: cumulativeCost ?? undefined });
      const contextUsage =
        !continuingInsertion &&
        !bash?.hasDeferredReceipt &&
        !subagents.active &&
        !message.is_error &&
        contextSessionId
          ? await sampleContextUsage(connection, contextSessionId, signal)
          : undefined;
      store.update('runs', run.id, { usage, ...(contextUsage && { contextUsage }) });
      store.event(run.id, sessionId, 'sdk.result', {
        subtype: message.subtype,
        isError: message.is_error,
        terminalReason: message.terminal_reason ?? null,
        stopReason: message.stop_reason,
        httpStatus: 'api_error_status' in message ? (message.api_error_status ?? null) : null,
        turns: message.num_turns,
        durationMs: message.duration_ms,
        apiDurationMs: message.duration_api_ms,
        ttftMs: 'ttft_ms' in message ? (message.ttft_ms ?? null) : null,
        deniedTools: message.permission_denials?.length ?? null,
      });
      store.event(run.id, sessionId, 'usage.updated', {});
      const action = turn.afterResultRecorded(() => ledger.flush());
      if (action === 'unfinished-subagents') {
        failure = '主会话结束时仍有未收尾的子任务。';
        live.cancellation.abort();
      }
      if (action !== 'continue') break;
    } else if (!(message.type === 'system' && message.subtype === 'status')) {
      store.event(run.id, sessionId, 'sdk.notice', {
        type: message.type,
        subtype: 'subtype' in message ? message.subtype : null,
      });
    }
  }

  const inputFailure = turn.unsettledInputFailure();
  const finalResult = turn.result;
  if (inputFailure) failure = inputFailure;
  else if (bash?.hasDeferredReceipt && !signal.aborted)
    failure = 'SDK 连接结束，Bash 命令未返回终态。';
  else if (subagents.active && !signal.aborted) failure = '主会话结束时仍有未收尾的子任务。';
  else if (!finalResult && !signal.aborted) failure = 'SDK 连接已结束，但未返回终态。';
  else if (finalResult?.is_error)
    failure =
      finalResult.subtype === 'success'
        ? cleanError(finalResult.result)
        : cleanError(finalResult.errors.join('\n'));

  return { failure };
}
