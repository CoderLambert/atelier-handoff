/**
 * @file 收集单次运行中 SDK 响应流及模型请求的计时。
 * @implementation 按当前 SDK 会话和父工具隔离流，只保留每条流的边界，并通过唯一响应标识合并请求跨度。
 * @updated 2026-11-27T02:58:23+08:00
 */
import type { SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  requestTimingLimit,
  type ModelRequestTiming,
  type RunRequestTiming,
  type SdkStreamTiming,
} from '../shared/request-timing.js';

type StreamEvent = SDKPartialAssistantMessage['event'];
type OpenStream = Omit<SdkStreamTiming, 'durationMs' | 'outcome'> & {
  responseId: string;
  started: number;
};
type ClosedStream = { responseId: string; timing: SdkStreamTiming };
export type ObservedModelRequest = { requestId?: string; timing: ModelRequestTiming };

function hasContent(event: StreamEvent): boolean {
  if (event.type === 'content_block_start') {
    const block = event.content_block;
    if (block.type === 'text') return block.text.length > 0;
    if (block.type === 'thinking') return block.thinking.length > 0;
    return true;
  }
  if (event.type !== 'content_block_delta') return false;
  const delta = event.delta;
  if (delta.type === 'text_delta') return delta.text.length > 0;
  if (delta.type === 'thinking_delta') return delta.thinking.length > 0;
  if (delta.type === 'input_json_delta') return delta.partial_json.length > 0;
  return delta.type !== 'signature_delta';
}

export class RequestTiming {
  readonly #open = new Map<string, OpenStream>();
  readonly #closed: ClosedStream[] = [];
  readonly #messageIdsByRequest = new Map<string, string | null>();
  #lastToolFinishedAt: number | undefined;
  #omitted = 0;

  finishedMainTool(at: number) {
    if (Number.isSafeInteger(at)) this.#lastToolFinishedAt = at;
  }

  linkAssistant(requestId: string | undefined, messageId: string) {
    if (!requestId || requestId.length > 256 || messageId.length > 256) return;
    if (this.#messageIdsByRequest.has(requestId)) {
      if (this.#messageIdsByRequest.get(requestId) !== messageId)
        this.#messageIdsByRequest.set(requestId, null);
    } else if (this.#messageIdsByRequest.size < requestTimingLimit) {
      this.#messageIdsByRequest.set(requestId, messageId);
    }
  }

  observe(message: SDKPartialAssistantMessage, at: number, clock: number) {
    const event = message.event;
    const key = `${message.session_id}:${message.parent_tool_use_id ?? ''}`;
    if (event.type === 'message_start') {
      this.#finish(key, clock, 'interrupted');
      if (this.#open.size >= requestTimingLimit) {
        this.#omitted++;
        return;
      }
      const ttft = message.ttft_ms;
      this.#open.set(key, {
        responseId: event.message.id,
        started: clock,
        firstEventAt: at,
        scope: message.parent_tool_use_id ? 'subagent' : 'main',
        ...(!message.parent_tool_use_id &&
          this.#lastToolFinishedAt !== undefined && {
            lastToolFinishedAt: this.#lastToolFinishedAt,
          }),
        ...(ttft !== undefined &&
          Number.isFinite(ttft) &&
          ttft >= 0 && { ttftMs: Math.round(ttft) }),
      });
      if (!message.parent_tool_use_id) this.#lastToolFinishedAt = undefined;
      return;
    }
    const stream = this.#open.get(key);
    if (!stream) return;
    if (event.type === 'message_stop') this.#finish(key, clock, 'complete');
    else if (stream.firstContentAfterEventMs === undefined && hasContent(event))
      stream.firstContentAfterEventMs = Math.max(0, Math.round(clock - stream.started));
  }

  #finish(key: string, clock: number, outcome: SdkStreamTiming['outcome']) {
    const stream = this.#open.get(key);
    if (!stream) return;
    this.#open.delete(key);
    if (this.#closed.length >= requestTimingLimit) {
      this.#omitted++;
      return;
    }
    const { responseId, started, ...timing } = stream;
    this.#closed.push({
      responseId,
      timing: { ...timing, durationMs: Math.max(0, Math.round(clock - started)), outcome },
    });
  }

  finish(clock: number, requests: ObservedModelRequest[] = [], omitted = 0): RunRequestTiming {
    for (const key of this.#open.keys()) this.#finish(key, clock, 'interrupted');
    const streamsById = new Map<string, ClosedStream | null>();
    for (const stream of this.#closed)
      streamsById.set(stream.responseId, streamsById.has(stream.responseId) ? null : stream);
    const associated = requests.map(({ requestId, timing }) => ({
      responseId: requestId ? this.#messageIdsByRequest.get(requestId) : undefined,
      timing,
    }));
    const counts = new Map<string, number>();
    for (const { responseId } of associated)
      if (responseId) counts.set(responseId, (counts.get(responseId) ?? 0) + 1);
    const linked = new Set<ClosedStream>();
    const records: RunRequestTiming['records'] = associated.map(({ responseId, timing }) => {
      const stream = responseId && counts.get(responseId) === 1 && streamsById.get(responseId);
      if (!stream) return { request: timing };
      linked.add(stream);
      return { request: timing, stream: stream.timing };
    });
    for (const stream of this.#closed)
      if (!linked.has(stream)) records.push({ stream: stream.timing });
    records.sort(
      (a, b) =>
        (a.request?.startedAt ?? a.stream?.firstEventAt ?? 0) -
        (b.request?.startedAt ?? b.stream?.firstEventAt ?? 0),
    );
    return {
      records: records.slice(0, requestTimingLimit),
      omitted: this.#omitted + omitted + Math.max(0, records.length - requestTimingLimit),
    };
  }
}
