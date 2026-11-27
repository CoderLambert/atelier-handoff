/**
 * @file 对话快照的按运行归并与历史轮次比较。
 * @implementation 用线性索引保留消息顺序、占位和页脚归属，以实体引用比较渲染切片。
 * @updated 2026-11-27T19:30:00+08:00
 */
import { activeStatuses } from '@shared/types';
import type { Snapshot } from '@/api/types';
import type { Subagent } from '@shared/subagents';
import type {
  Artifact,
  Attachment,
  Message,
  Permission,
  Run,
  RunEvent,
  ToolCall,
} from '@shared/types';
import type { MessageDraftAction } from './message-actions';
import type { MouseEvent } from 'react';

export const isActive = (run: Run) => activeStatuses.includes(run.status);
export const recoverable = (run: Run) => ['failed', 'stopped', 'interrupted'].includes(run.status);

export interface RunSlice {
  run?: Run;
  messages: readonly Message[];
  tools: readonly ToolCall[];
  events: readonly RunEvent[];
  artifacts: readonly Artifact[];
  permissions: readonly Permission[];
  subagents: readonly Subagent[];
  attachments: readonly (Attachment | undefined)[];
  hasAssistantText: boolean;
  contextRestarted: boolean;
}

export interface OrderedTurn {
  kind: 'ordered';
  slice: RunSlice & { run: Run };
  hasGlobalLastMessage: boolean;
  // Only the run that owns the global head needs to know its identity.
  lastRealMessageId?: string;
}

export interface LegacyTurn {
  kind: 'legacy';
  slice: RunSlice;
  message: Message;
  isRealMessage: boolean;
  isFooterOwner: boolean;
  isLastMessage: boolean;
  hasSubsequent: boolean;
}

const EMPTY: readonly never[] = [];

function appendToRun<T extends { runId: string }>(groups: Map<string, T[]>, item: T) {
  const group = groups.get(item.runId);
  if (group) group.push(item);
  else groups.set(item.runId, [item]);
}

function groupByRun<T extends { runId: string }>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) appendToRun(groups, item);
  return groups;
}

type ConversationSnapshot = Pick<
  Snapshot,
  | 'runs'
  | 'messages'
  | 'tools'
  | 'events'
  | 'artifacts'
  | 'permissions'
  | 'subagents'
  | 'attachments'
>;

export function buildConversationTurns(
  snapshot: ConversationSnapshot,
): (OrderedTurn | LegacyTurn)[] {
  const messages = new Map<string, Message[]>();
  const runFooterOwners = new Map<string, string>();
  const assistantTextRuns = new Set<string>();
  for (const message of snapshot.messages) {
    appendToRun(messages, message);
    if (message.role === 'assistant') {
      runFooterOwners.set(message.runId, message.id);
      if (!assistantTextRuns.has(message.runId) && message.text.trim())
        assistantTextRuns.add(message.runId);
    }
  }
  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  const tools = groupByRun(snapshot.tools);
  const events = groupByRun(snapshot.events);
  const artifacts = groupByRun(snapshot.artifacts);
  const permissions = groupByRun(snapshot.permissions);
  const subagents = groupByRun(snapshot.subagents ?? EMPTY);
  const attachments = new Map(snapshot.attachments.map((item) => [item.id, item]));
  const missing = new Map<string, Message>();
  for (const run of snapshot.runs) {
    if (runFooterOwners.has(run.id)) continue;
    const reply: Message = {
      id: `run-reply:${run.id}`,
      sessionId: run.sessionId,
      runId: run.id,
      role: 'assistant',
      text: '',
      createdAt: run.createdAt,
    };
    missing.set(run.id, reply);
    runFooterOwners.set(run.id, reply.id);
  }

  const display: { message: Message; isRealMessage: boolean }[] = [];
  for (const message of snapshot.messages) {
    display.push({ message, isRealMessage: true });
    if (message.role !== 'user') continue;
    const reply = missing.get(message.runId);
    if (reply) {
      display.push({ message: reply, isRealMessage: false });
      missing.delete(message.runId);
    }
  }
  for (const message of missing.values()) display.push({ message, isRealMessage: false });

  const slices = new Map<string, RunSlice>();
  const seenOrdered = new Set<string>();
  const turns: (OrderedTurn | LegacyTurn)[] = [];
  const lastDisplay = display.at(-1);
  const lastReal = snapshot.messages.at(-1);
  for (const entry of display) {
    const { message, isRealMessage } = entry;
    const { runId } = message;
    const run = runs.get(runId);
    if (seenOrdered.has(runId)) continue;
    let slice = slices.get(runId);
    if (!slice) {
      const runEvents = events.get(runId) ?? EMPTY;
      slice = {
        run,
        messages: messages.get(runId) ?? EMPTY,
        tools: tools.get(runId) ?? EMPTY,
        events: runEvents,
        artifacts: artifacts.get(runId) ?? EMPTY,
        permissions: permissions.get(runId) ?? EMPTY,
        subagents: subagents.get(runId) ?? EMPTY,
        attachments: run?.attachmentIds.map((id) => attachments.get(id)) ?? EMPTY,
        hasAssistantText: assistantTextRuns.has(runId),
        contextRestarted: runEvents.some((event) => event.type === 'sdk.context_restarted'),
      };
      slices.set(runId, slice);
    }
    if (run?.transcript?.version === 1) {
      seenOrdered.add(runId);
      turns.push({
        kind: 'ordered',
        slice: { ...slice, run },
        hasGlobalLastMessage: lastDisplay?.message.runId === runId,
        lastRealMessageId: lastReal?.runId === runId ? lastReal.id : undefined,
      });
    } else {
      turns.push({
        kind: 'legacy',
        slice,
        message,
        isRealMessage,
        isFooterOwner: runFooterOwners.get(runId) === message.id,
        isLastMessage: entry === lastDisplay,
        hasSubsequent: isRealMessage && message.id !== lastReal?.id,
      });
    }
  }
  return turns;
}

export interface TurnActions {
  onRetry: (id: string) => void;
  onTrace: (id: string) => void;
  onOpenSchedule?: (taskId: string) => void;
  onPermission: (permission: Permission) => void;
  onOutput: (tool: ToolCall) => void;
  onLinkClick?: (url: string, event: MouseEvent<HTMLAnchorElement>) => void;
  onEditMessage?: MessageDraftAction;
  onQuoteMessage?: MessageDraftAction;
  onForkMessage?: (messageId: string) => void;
  onRewindMessage?: MessageDraftAction;
}

export interface TurnState {
  sessionId: string;
  hasFork: boolean;
  submitting: boolean;
  archived: boolean;
  forkingMessageId?: string;
  rewindDisabledReason?: string;
  isComposerPlanOwner: boolean;
  stopPending: boolean;
  retryDisabled: boolean;
  actions: TurnActions;
  messageTime: { full: Intl.DateTimeFormat; short: Intl.DateTimeFormat };
}

export type OrderedTurnProps = TurnState & { turn: OrderedTurn };
export type LegacyTurnProps = TurnState & { turn: LegacyTurn };

function areArrayElementsEqual<T>(a: readonly T[], b: readonly T[]) {
  return a === b || (a.length === b.length && a.every((item, index) => item === b[index]));
}

function areTurnActionsEqual(a: TurnActions, b: TurnActions) {
  return (
    a === b ||
    (a.onRetry === b.onRetry &&
      a.onTrace === b.onTrace &&
      a.onOpenSchedule === b.onOpenSchedule &&
      a.onPermission === b.onPermission &&
      a.onOutput === b.onOutput &&
      a.onLinkClick === b.onLinkClick &&
      a.onEditMessage === b.onEditMessage &&
      a.onQuoteMessage === b.onQuoteMessage &&
      a.onForkMessage === b.onForkMessage &&
      a.onRewindMessage === b.onRewindMessage)
  );
}

function areTurnPropsEqual(a: TurnState, b: TurnState) {
  return (
    a.sessionId === b.sessionId &&
    a.hasFork === b.hasFork &&
    a.submitting === b.submitting &&
    a.archived === b.archived &&
    a.forkingMessageId === b.forkingMessageId &&
    a.rewindDisabledReason === b.rewindDisabledReason &&
    a.isComposerPlanOwner === b.isComposerPlanOwner &&
    a.stopPending === b.stopPending &&
    a.retryDisabled === b.retryDisabled &&
    areTurnActionsEqual(a.actions, b.actions) &&
    a.messageTime === b.messageTime
  );
}

function areRunDetailsEqual(a: RunSlice, b: RunSlice) {
  return (
    areArrayElementsEqual(a.tools, b.tools) &&
    areArrayElementsEqual(a.events, b.events) &&
    areArrayElementsEqual(a.artifacts, b.artifacts) &&
    areArrayElementsEqual(a.permissions, b.permissions) &&
    areArrayElementsEqual(a.subagents, b.subagents)
  );
}

export function areOrderedTurnPropsEqual(a: OrderedTurnProps, b: OrderedTurnProps) {
  const left = a.turn;
  const right = b.turn;
  return (
    areTurnPropsEqual(a, b) &&
    left.hasGlobalLastMessage === right.hasGlobalLastMessage &&
    left.lastRealMessageId === right.lastRealMessageId &&
    left.slice.run === right.slice.run &&
    left.slice.contextRestarted === right.slice.contextRestarted &&
    left.slice.hasAssistantText === right.slice.hasAssistantText &&
    areArrayElementsEqual(left.slice.messages, right.slice.messages) &&
    areArrayElementsEqual(left.slice.attachments, right.slice.attachments) &&
    areRunDetailsEqual(left.slice, right.slice)
  );
}

export function areLegacyTurnPropsEqual(a: LegacyTurnProps, b: LegacyTurnProps) {
  const left = a.turn;
  const right = b.turn;
  const real = left.isRealMessage;
  return (
    areTurnPropsEqual(a, b) &&
    real === right.isRealMessage &&
    // A synthetic message's fields are determined by its run.
    (real ? left.message === right.message : left.message.id === right.message.id) &&
    left.slice.run === right.slice.run &&
    left.isFooterOwner === right.isFooterOwner &&
    left.isLastMessage === right.isLastMessage &&
    left.hasSubsequent === right.hasSubsequent &&
    (left.message.role !== 'user' ||
      (left.slice.contextRestarted === right.slice.contextRestarted &&
        areArrayElementsEqual(left.slice.attachments, right.slice.attachments))) &&
    (!left.isFooterOwner || areRunDetailsEqual(left.slice, right.slice))
  );
}
