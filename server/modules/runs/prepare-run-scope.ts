/**
 * @file 解析运行的智能体、Skill、MCP 和浏览器授权范围。
 * @implementation 按可选 Skill ID 范围解析扩展并生成授权指纹，冻结首次解析结果，提供重新计算的闭包供落库前复核。
 * @updated 2026-11-27T02:25:28+08:00
 */
import { AppError, type Session } from '../../../shared/types.js';
import type { AgentProfiles } from '../../agent-profiles.js';
import { agentCapabilitiesFor, resolveAgentExtensions } from '../../agent-scope.js';
import type { DesktopBrowserAccess } from '../../desktop-browser-access.js';
import type { ProjectExtensions } from '../../extensions.js';
import { fingerprint } from '../../files.js';
import type { RunSkill } from '../../run-skills.js';
import {
  applySkillScope,
  resolveSkillSelections,
  type SkillInheritance,
} from '../../skill-inheritance.js';
import type { WorktreeRecord } from '../git/worktree-repository.js';
import type { SkillScope } from '../skills/scope.js';
import type { Executor, SessionMessageInput } from './message-input.js';

export function prepareRunScope({
  agents,
  extensions,
  inheritance,
  skills,
  browserAccess,
  projectId,
  session,
  request,
  executor,
  retryOf,
  workspacePath,
  binding,
  allowedSkillIds,
}: {
  agents: Pick<AgentProfiles, 'requireReady'>;
  extensions: Pick<ProjectExtensions, 'get' | 'resolve'>;
  inheritance: Pick<SkillInheritance, 'snapshot'>;
  skills: SkillScope;
  browserAccess: Pick<DesktopBrowserAccess, 'read'>;
  projectId: string;
  session: Session;
  request: SessionMessageInput;
  executor: Executor;
  retryOf: string | null;
  workspacePath: string;
  binding: Pick<WorktreeRecord, 'id' | 'branch'> | undefined;
  allowedSkillIds?: ReadonlySet<string>;
}) {
  const revision = session.agentRevisionId
    ? agents.requireReady(projectId, session.agentRevisionId)
    : undefined;
  const capabilities = revision
    ? agentCapabilitiesFor(revision, request.mode, Boolean(retryOf))
    : undefined;
  if (revision && request.mode === 'edit' && revision.config.mode !== 'edit')
    throw new AppError('AGENT_MODE_DENIED', '此智能体只允许只读运行。', 403);
  if (
    capabilities &&
    ((request.contextPaths.length && !capabilities.includes('context')) ||
      (request.attachmentIds.length && !capabilities.includes('attachments')))
  )
    throw new AppError('AGENT_CAPABILITY_DENIED', '此智能体未启用所选上下文或附件能力。', 403);
  const skillInputs = () =>
    skills.context(
      projectId,
      session,
      executor === 'native-v1',
      workspacePath,
      executor === 'project-v1' && request.mode === 'edit' && request.approvalMode === 'automatic',
    );
  const resolveExtensions = () => {
    if (retryOf) return null;
    const context = skillInputs();
    const snapshot = inheritance.snapshot(context, true);
    const selections = resolveSkillSelections(snapshot, request.extensionSelections);
    const bundle = revision
      ? resolveAgentExtensions(extensions, revision, request.mode, request.text, selections.project)
      : extensions.resolve(projectId, request.mode, request.text, selections.project);
    const scoped = applySkillScope(
      snapshot,
      bundle,
      context.installed,
      selections.local,
      request.text,
      allowedSkillIds,
    );
    return { ...bundle, ...scoped, skillScope: skills.automatic(context, snapshot) };
  };
  const bundle = resolveExtensions();
  const profilePrompt = revision
    ? `智能体 ${revision.config.name} 的任务说明（受本轮工具与权限约束）：\n${revision.config.instructions}\n\n`
    : '';
  const resolvedInput = profilePrompt + (bundle?.prompt ?? request.text);
  const resolveScope = (currentBundle: ReturnType<typeof resolveExtensions>) => {
    const skills: RunSkill[] = currentBundle?.skills ?? [];
    const policy =
      !retryOf && (!capabilities || capabilities.includes('browser'))
        ? browserAccess.read(projectId)
        : undefined;
    const browserRevision =
      policy?.available && policy.enabled ? (policy.revision ?? undefined) : undefined;
    const scope = fingerprint(
      JSON.stringify({
        agent: revision?.id,
        used: currentBundle?.used,
        mcp: currentBundle?.mcp,
        skills,
        browserRevision,
        ...(executor === 'native-v1' ? { executor } : {}),
        ...(binding ? { worktree: [binding.id, binding.branch, workspacePath] } : {}),
      }),
    );
    return { skills, browserRevision, scope };
  };
  return {
    revision,
    capabilities,
    bundle,
    resolvedInput,
    initialScope: () => resolveScope(bundle),
    recheckScope: () => resolveScope(resolveExtensions()),
  };
}
