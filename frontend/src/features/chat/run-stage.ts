/**
 * @file 推导对话运行的展示阶段和本地化工具名称。
 * @implementation 以同一优先级组合停止请求、运行状态、前后台工具、子任务和模型事件。
 * @updated 2026-11-27T16:59:48+08:00
 */
import type { getTranslator } from '@/i18n';
import type { Subagent } from '@shared/subagents';
import type { Run, RunEvent, ToolCall } from '@shared/types';

type ChatTranslator = ReturnType<typeof getTranslator<'chat'>>;
type RunSubagent = Pick<Subagent, 'id' | 'runId' | 'sessionId' | 'status'>;

const toolLabels: Readonly<
  Record<
    string,
    | 'tool.read'
    | 'tool.skill'
    | 'tool.list'
    | 'tool.search'
    | 'tool.edit'
    | 'tool.write'
    | 'tool.delete'
    | 'tool.command'
    | 'tool.weather'
    | 'tool.plan'
    | 'tool.publish'
    | 'tool.navigate'
    | 'tool.snapshot'
    | 'tool.screenshot'
    | 'tool.click'
    | 'tool.type'
  >
> = {
  Read: 'tool.read',
  Skill: 'tool.skill',
  list_files: 'tool.list',
  search_files: 'tool.search',
  edit_file: 'tool.edit',
  write_file: 'tool.write',
  delete_file: 'tool.delete',
  run_command: 'tool.command',
  weather_lookup: 'tool.weather',
  update_plan: 'tool.plan',
  publish_artifact: 'tool.publish',
  browser_navigate: 'tool.navigate',
  browser_snapshot: 'tool.snapshot',
  browser_take_screenshot: 'tool.screenshot',
  browser_click: 'tool.click',
  browser_type: 'tool.type',
};
const modelEvents = new Set([
  'sdk.initialized',
  'sdk.api_retry',
  'tool.started',
  'tool.finished',
  'subagent.started',
  'subagent.finished',
  'message.delta',
]);
export const receivingWindowMs = 2000;

export function toolLabel(name: string, t: ChatTranslator): string {
  const short = name.replace(/^mcp__atelier__/, '');
  const key = Object.hasOwn(toolLabels, short) ? toolLabels[short] : undefined;
  return key ? t(key) : short;
}

export function deriveRunStage(
  {
    run,
    tools,
    events,
    notices,
    subagents,
    stopPending,
    now,
  }: {
    run: Pick<Run, 'id' | 'sessionId' | 'status'>;
    tools: readonly ToolCall[];
    events: readonly RunEvent[];
    notices?: NonNullable<Run['transcript']>['notices'];
    subagents?: readonly RunSubagent[];
    stopPending?: boolean;
    now: number;
  },
  t: ChatTranslator,
) {
  const status = stopPending ? 'stopping' : run.status;
  const activity = events.findLast((event) => modelEvents.has(event.type));
  const stage = <Key extends string>(key: Key, label: string) => ({ key, label, status, activity });

  if (status === 'stopping') return stage('progress.stopping', t('progress.stopping'));
  if (status === 'queued') return stage('progress.queued', t('progress.queued'));
  if (status === 'awaiting_permission')
    return stage('progress.awaitingApproval', t('progress.awaitingApproval'));

  const runningSubagents = new Set(
    subagents
      ?.filter(
        (agent) =>
          agent.runId === run.id && agent.sessionId === run.sessionId && agent.status === 'running',
      )
      .map((agent) => agent.id),
  );
  const ongoing = tools.findLast(
    (tool) =>
      tool.status === 'running' &&
      !tool.subagentId &&
      tool.bashExecution?.phase !== 'background' &&
      !runningSubagents.has(tool.id),
  );
  if (ongoing?.bashExecution?.phase === 'stopping')
    return stage('progress.stoppingBash', t('progress.stoppingBash'));
  if (ongoing)
    return stage(
      'progress.callingTool',
      t('progress.callingTool', { name: toolLabel(ongoing.name, t) }),
    );

  const preparing = notices?.findLast((notice) => notice.kind === 'tool_preparing');
  if (preparing?.kind === 'tool_preparing')
    return stage(
      'transcript.toolPreparing',
      t('transcript.toolPreparing', { name: toolLabel(preparing.toolName, t) }),
    );
  if (runningSubagents.size)
    return stage(
      'progress.runningSubtasks',
      t('progress.runningSubtasks', { count: runningSubagents.size }),
    );
  if (activity?.type === 'sdk.api_retry')
    return stage('progress.retryingModel', t('progress.retryingModel'));
  if (tools.some((tool) => tool.status === 'running' && tool.bashExecution?.phase === 'background'))
    return stage('progress.backgroundBash', t('progress.backgroundBash'));
  if (activity?.type === 'message.delta' && now - Date.parse(activity.at) < receivingWindowMs)
    return stage('progress.receiving', t('progress.receiving'));
  if (!activity && !tools.length) return stage('progress.starting', t('progress.starting'));
  return stage('progress.waitingModel', t('progress.waitingModel'));
}
