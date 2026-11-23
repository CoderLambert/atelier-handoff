/**
 * @file 从持久化会话历史生成跨轮恢复检查点。
 * @implementation 按会话和执行范围形成有界的用户要求、来源与操作摘要，并按 UTF-8 字节选取近期可见对话。
 * @updated 2026-11-23T18:25:00+08:00
 */
import type { InheritedMessage, Message, Run, ToolCall } from '../shared/types.js';
import {
  checkpointToolRecord,
  checkpointReference,
  checkpointUserExcerpt,
  type ProgressEvidence,
} from './harness-progress.js';

type RecoveryRows = {
  runs: readonly Run[];
  messages: readonly Message[];
  tools: readonly ToolCall[];
};
type Scope = Pick<Run, 'id' | 'projectId' | 'sessionId' | 'executor' | 'agent'>;
type Receipt = Pick<ProgressEvidence, 'runId' | 'toolCallId' | 'tool' | 'outcome'>;

/** Rows are in persistent insertion order, also when timestamps tie. */
function previousRuns(current: Scope, runs: readonly Run[]): Run[] {
  const prior: Run[] = [];
  for (const run of runs) {
    if (
      run.id === current.id &&
      run.sessionId === current.sessionId &&
      run.projectId === current.projectId
    )
      return prior;
    if (run.sessionId !== current.sessionId || run.projectId !== current.projectId) continue;
    if (
      current.executor !== 'native-v1' &&
      ((run.executor ?? 'project-v1') !== (current.executor ?? 'project-v1') ||
        run.agent?.revisionId !== current.agent?.revisionId)
    )
      continue;
    prior.push(run);
  }
  return [];
}

/** A bounded section retains its first entry and evicts the oldest of the remaining entries. */
function section<T>(byteLimit: number, itemLimit: number) {
  const items: T[] = [];
  const sizes: number[] = [];
  let bytes = 0;
  let omitted = 0;
  return {
    items,
    add(item: T) {
      const size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (size > byteLimit) {
        omitted++;
        return;
      }
      items.push(item);
      sizes.push(size);
      bytes += size;
      while (bytes > byteLimit || items.length > itemLimit) {
        // On the two-entry boundary keep the latest correction if both cannot fit.
        const index = items.length > 2 ? 1 : 0;
        bytes -= sizes.splice(index, 1)[0] ?? 0;
        items.splice(index, 1);
        omitted++;
      }
    },
    snapshot() {
      return { items, omitted };
    },
  };
}

function groupRows<T extends { runId: string; sessionId: string }>(
  rows: readonly T[],
  allowed: ReadonlySet<string>,
  sessionId: string,
) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    if (row.sessionId !== sessionId || !allowed.has(row.runId)) continue;
    const group = grouped.get(row.runId);
    if (group) group.push(row);
    else grouped.set(row.runId, [row]);
  }
  return grouped;
}

export const sessionCheckpointByteLimit = 24 * 1024;

/** Render only when rebuilding SDK context. The current request follows this historical data. */
export function sessionRecoveryContext(
  current: Scope,
  rows: RecoveryRows,
  inherited: readonly InheritedMessage[] = [],
): string {
  const runs = previousRuns(current, rows.runs);
  if (!runs.length && !inherited.length) return '';
  const ids = new Set(runs.map(({ id }) => id));
  const messages = groupRows(
    rows.messages.filter(({ role }) => role === 'user'),
    ids,
    current.sessionId,
  );
  const requests = section<{
    runId: string | null;
    inherited?: true;
    messageId: string | null;
    text: string;
  }>(6_500, 20);
  const sources = section<{
    runId: string;
    toolCallId: string;
    url: string;
    status: 'discovered_only';
  }>(2_400, 12);
  const fetched = section<{
    runId: string;
    toolCallId: string;
    url: string;
    status: 'completed';
  }>(2_400, 12);
  const receipts = section<Receipt>(1_600, 16);
  const changes = section<Receipt & { state: 'confirmed' }>(2_600, 16);
  const uncertain = section<Receipt & { state: 'unverified' }>(3_000, 16);
  const open = section<Receipt>(1_800, 10);
  const plans = section<{ runId: string; content: string; status: string }>(2_000, 8);
  let shortened = false;
  const handle = ({ runId, toolCallId, tool, outcome }: ProgressEvidence): Receipt => ({
    runId,
    toolCallId,
    tool,
    outcome,
  });
  for (const message of inherited) {
    if (message.role !== 'user') continue;
    if (message.text.length > 768) shortened = true;
    requests.add({
      runId: null,
      inherited: true,
      messageId: checkpointReference(message.id),
      text: checkpointUserExcerpt(message.text),
    });
  }
  for (const run of runs) {
    const users = messages.get(run.id) ?? [];
    const runId = checkpointReference(run.id);
    // Preserve initial instructions even when steer messages superseded the run's initial goal.
    const request = (raw: string, messageId: string | null) => {
      const text = checkpointUserExcerpt(raw);
      if (raw.length > 768) shortened = true;
      requests.add({
        runId,
        messageId: messageId === null ? null : checkpointReference(messageId),
        text,
      });
    };
    if (users[0]?.text !== run.prompt) request(run.prompt, null);
    for (const user of users) request(user.text, user.id);
    for (const step of run.plan) {
      if (step.status === 'completed') continue;
      if (step.content.length > 384) shortened = true;
      plans.add({ runId, status: step.status, content: checkpointUserExcerpt(step.content, 384) });
    }
  }
  // Read each receipt exactly once, before any per-run display truncation can drop early evidence.
  for (const tool of rows.tools) {
    if (tool.sessionId !== current.sessionId || !ids.has(tool.runId)) continue;
    const { evidence, sideEffect, discoveredSources, fetchedSource } = checkpointToolRecord(tool);
    const record = handle(evidence);
    if (fetchedSource)
      fetched.add({
        runId: record.runId,
        toolCallId: record.toolCallId,
        url: fetchedSource.url,
        status: 'completed',
      });
    for (const source of discoveredSources) {
      if (!sources.items.some((known) => known.url === source.url))
        sources.add({
          runId: record.runId,
          toolCallId: record.toolCallId,
          url: source.url,
          status: 'discovered_only',
        });
    }
    if (sideEffect === 'unverified') uncertain.add({ ...record, state: sideEffect });
    else if (sideEffect === 'confirmed') changes.add({ ...record, state: sideEffect });
    else if (record.outcome === 'completed') receipts.add(record);
    if (record.outcome !== 'completed') open.add(record);
  }
  const sections = {
    userRequests: requests.snapshot(),
    discoveredSources: sources.snapshot(),
    fetchedSources: fetched.snapshot(),
    toolReceipts: receipts.snapshot(),
    confirmedChanges: changes.snapshot(),
    effectsToVerify: uncertain.snapshot(),
    previousUnresolved: open.snapshot(),
    previousOpenSteps: plans.snapshot(),
  };
  const latest = runs[runs.length - 1];
  const checkpoint = {
    schemaVersion: 2,
    sessionId: checkpointReference(current.sessionId),
    runCount: runs.length,
    latestRun: latest && { id: checkpointReference(latest.id), status: latest.status },
    shortened: shortened || Object.values(sections).some(({ omitted }) => omitted > 0),
    ...sections,
  };
  const readback =
    current.executor === 'native-v1' && !current.agent
      ? '需要此前网页的内容时，优先调用 mcp__atelier__read_tool_output 并传对应 toolCallId 回查本会话已保存的结果；如信息不足或需要更新，可重新获取。仅 native 主会话可跨轮回查，子任务不继承此权限。'
      : '本模式不能跨轮回查工具结果；如需正文，请按当前权限重新获取。';
  return `会话恢复检查点（以下是按时间排列的历史资料。用户本轮任务及后续更正优先。discoveredSources 只证明链接被发现；fetchedSources 关联已完成 WebFetch 的请求 URL 和工具 ID，完成不等于内容已核实。${readback}对历史步骤与副作用先核对当前状态。）\n${JSON.stringify(checkpoint)}`;
}

/** Render recent visible messages within the byte cap, including the omission notice. */
export function recentConversationContext(
  current: Scope,
  messages: readonly Message[],
  inherited: readonly InheritedMessage[],
): string {
  const limit = 96 * 1024;
  const notice = '仅恢复最近的对话片段。较早的完整记录可在会话中查看。\n';
  const lines: string[] = [];
  let remaining = limit - Buffer.byteLength(notice);
  const append = (message: InheritedMessage): boolean => {
    const prefix = `${message.role}: `;
    const separator = lines.length ? 2 : 0;
    const size = Buffer.byteLength(message.text) + Buffer.byteLength(prefix) + separator;
    if (size <= remaining) {
      lines.push(prefix + message.text);
      remaining -= size;
      return true;
    }
    const marker = '[前文已省略] ';
    const available = remaining - separator - Buffer.byteLength(prefix + marker);
    if (available > 0) {
      const bytes = Buffer.from(message.text.slice(-available));
      let start = Math.max(0, bytes.length - available);
      while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
      lines.push(prefix + marker + bytes.toString('utf8', start));
    }
    return false;
  };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.sessionId === current.sessionId && m.runId !== current.id && !append(m))
      return notice + lines.reverse().join('\n\n');
  }
  for (let i = inherited.length - 1; i >= 0; i--) {
    const m = inherited[i];
    if (m && !append(m)) return notice + lines.reverse().join('\n\n');
  }
  return lines.reverse().join('\n\n');
}
