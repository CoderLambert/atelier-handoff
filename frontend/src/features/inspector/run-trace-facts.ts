/**
 * @file 提供运行轨迹事件合并、单趟摘要扫描与自动审批统计纯函数。
 * @implementation 通过单趟扫描收集全部轨迹关键事件并建立自动批准工具 ID 集合，避免渲染阶段多趟遍历与重复查找。
 * @updated 2026-11-27T22:25:00+08:00
 */
import type { Permission, RunEvent } from '@shared/types';

export type TraceEventPayload = Record<string, unknown>;

export interface RunTraceEventSummary {
  readonly stopSequence: number | undefined;
  readonly result: TraceEventPayload | undefined;
  readonly init: TraceEventPayload | undefined;
  readonly firstText: TraceEventPayload | undefined;
  readonly exit: TraceEventPayload | undefined;
  readonly retryCount: number;
  readonly invokedPayloads: readonly TraceEventPayload[];
  readonly discovered: TraceEventPayload | undefined;
}

export interface AutomaticApprovalSummary {
  readonly count: number;
  readonly toolIds: ReadonlySet<string>;
}

export function mergeRunTraceEvents(
  traceEvents: readonly RunEvent[] | undefined,
  snapshotEvents: readonly RunEvent[],
  runId: string,
  limit = 600,
): RunEvent[] {
  const records = new Map<number, RunEvent>();
  if (traceEvents) {
    for (const event of traceEvents) records.set(event.id, event);
  }
  for (const event of snapshotEvents) {
    if (event.runId === runId && event.type !== 'message.delta') {
      records.set(event.id, event);
    }
  }
  return [...records.values()].sort((a, b) => a.seq - b.seq).slice(-limit);
}

export function scanRunTraceEvents(events: readonly RunEvent[]): RunTraceEventSummary {
  let stopSequence: number | undefined;
  let result: TraceEventPayload | undefined;
  let init: TraceEventPayload | undefined;
  let firstText: TraceEventPayload | undefined;
  let exit: TraceEventPayload | undefined;
  let retryCount = 0;
  const invokedPayloads: TraceEventPayload[] = [];
  let discovered: TraceEventPayload | undefined;

  for (const event of events) {
    switch (event.type) {
      case 'run.status_changed':
        if (stopSequence === undefined && event.payload.status === 'stopping') {
          stopSequence = event.seq;
        }
        break;
      case 'sdk.result':
        result = event.payload;
        break;
      case 'sdk.initialized':
        init = event.payload;
        break;
      case 'sdk.first_text':
        if (firstText === undefined) firstText = event.payload;
        break;
      case 'process.exited':
        exit = event.payload;
        break;
      case 'sdk.api_retry':
        retryCount += 1;
        break;
      case 'skill.invoked':
        invokedPayloads.push(event.payload);
        break;
      case 'skills.discovered':
        discovered = event.payload;
        break;
      default:
        break;
    }
  }

  return {
    stopSequence,
    result,
    init,
    firstText,
    exit,
    retryCount,
    invokedPayloads,
    discovered,
  };
}

export function summarizeAutomaticApprovals(
  permissions: readonly Permission[],
): AutomaticApprovalSummary {
  const toolIds = new Set<string>();
  let count = 0;
  for (const permission of permissions) {
    if (permission.decisionSource === 'automatic') {
      count += 1;
      toolIds.add(permission.toolCallId);
    }
  }
  return { count, toolIds };
}
