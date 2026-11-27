/**
 * @file 子任务执行记录归组与审批来源解析。
 * @implementation 按会话和运行切片聚合运行关联的子任务工具调用与权限，解析审批对应的子任务来源。
 * @updated 2026-11-27T19:30:00+08:00
 */
import type { Subagent } from '@shared/subagents';
import type { Permission, Run, ToolCall } from '@shared/types';

interface RunWorkInput {
  session: { id: string };
  tools: readonly ToolCall[];
  permissions?: readonly Permission[];
  subagents?: readonly Subagent[];
}

export type SubagentSource = Pick<Subagent, 'id' | 'title'>;

export interface SubagentWork {
  id: string;
  subagent?: Subagent;
  tools: ToolCall[];
  permissions: Permission[];
}

export function permissionSubagentSource(
  snapshot: RunWorkInput,
  permission: Permission,
): SubagentSource | undefined {
  if (permission.sessionId !== snapshot.session.id) return;
  const id =
    permission.subagentId ||
    snapshot.tools.find(
      (tool) =>
        tool.id === permission.toolCallId &&
        tool.sessionId === permission.sessionId &&
        tool.runId === permission.runId,
    )?.subagentId;
  if (!id) return;
  const subagent = snapshot.subagents?.find(
    (item) =>
      item.id === id && item.sessionId === permission.sessionId && item.runId === permission.runId,
  );
  return { id, title: subagent?.title || id };
}

export function groupRunWork(snapshot: RunWorkInput, run: Run) {
  const tools: ToolCall[] = [];
  const permissions: Permission[] = [];
  const groups = new Map<string, SubagentWork>();
  const inRun = (item: { sessionId: string; runId: string }) =>
    run.sessionId === snapshot.session.id &&
    item.sessionId === run.sessionId &&
    item.runId === run.id;
  function group(id: string) {
    let work = groups.get(id);
    if (!work) {
      work = { id, tools: [], permissions: [] };
      groups.set(id, work);
    }
    return work;
  }
  for (const subagent of snapshot.subagents ?? []) {
    if (inRun(subagent)) group(subagent.id).subagent = subagent;
  }
  const toolOwners = new Map<string, string>();
  for (const tool of snapshot.tools) {
    if (!inRun(tool)) continue;
    if (tool.subagentId) {
      group(tool.subagentId).tools.push(tool);
      toolOwners.set(tool.id, tool.subagentId);
    } else tools.push(tool);
  }
  for (const permission of snapshot.permissions ?? []) {
    if (!inRun(permission)) continue;
    const id = permission.subagentId || toolOwners.get(permission.toolCallId);
    if (id) group(id).permissions.push(permission);
    else permissions.push(permission);
  }
  return { tools, permissions, subagents: Array.from(groups.values()) };
}
