/**
 * @file 将新运行的权威顺序投影为对话行。
 * @implementation 保留原消息身份及 UTF-16 文本区间，过滤历史 SDK 重试通知，只合并相邻的只读工具展示组。
 * @updated 2026-11-27T14:21:24+08:00
 */
import type { Message, Run, ToolCall } from '@shared/types';
import type { TranscriptNotice } from '@shared/ordered-transcript';

type VisibleNotice = Exclude<TranscriptNotice, { kind: 'api_retry' }>;

export type TranscriptRow =
  | {
      kind: 'text' | 'user';
      key: string;
      order: number;
      message: Message;
      text: string;
      at: string;
      footer: boolean;
    }
  | { kind: 'tool'; key: string; order: number; tools: ToolCall[] }
  | { kind: 'notice'; key: string; order: number; notice: VisibleNotice };

export function isReadOnlyTranscriptTool(tool: ToolCall): boolean {
  return ['Read', 'Grep', 'Glob', 'read_file', 'list_files', 'search_files'].includes(
    tool.name.replace(/^mcp__atelier__/, ''),
  );
}

export function orderedTranscriptRows(
  run: Run,
  messages: Message[],
  tools: ToolCall[],
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const message of messages) {
    if (message.runId !== run.id) continue;
    if (message.role === 'user' && message.transcriptOrder !== undefined) {
      rows.push({
        kind: 'user',
        key: `user:${message.id}`,
        order: message.transcriptOrder,
        message,
        text: message.text,
        at: message.createdAt,
        footer: true,
      });
    } else if (message.role === 'assistant') {
      const parts = message.transcriptParts ?? [];
      parts.forEach((part, index) =>
        rows.push({
          kind: 'text',
          key: part.id,
          order: part.order,
          message,
          text: message.text.slice(part.start, part.end),
          at: part.at,
          footer: index === parts.length - 1,
        }),
      );
    }
  }
  for (const tool of tools) {
    if (tool.runId === run.id && !tool.subagentId && tool.transcriptOrder !== undefined) {
      rows.push({
        kind: 'tool',
        key: `tool:${tool.id}`,
        order: tool.transcriptOrder,
        tools: [tool],
      });
    }
  }
  for (const notice of run.transcript?.notices ?? []) {
    if (notice.kind === 'api_retry') continue;
    rows.push({
      kind: 'notice',
      key: 'toolCallId' in notice ? `tool:${notice.toolCallId}` : `notice:${notice.order}`,
      order: notice.order,
      notice,
    });
  }
  rows.sort((a, b) => a.order - b.order);
  const grouped: TranscriptRow[] = [];
  for (const row of rows) {
    const previous = grouped.at(-1);
    if (
      row.kind === 'tool' &&
      row.tools.every(isReadOnlyTranscriptTool) &&
      previous?.kind === 'tool' &&
      previous.tools.every(isReadOnlyTranscriptTool)
    )
      previous.tools.push(...row.tools);
    else grouped.push(row);
  }
  return grouped;
}
