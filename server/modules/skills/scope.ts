/**
 * @file 解析项目和会话的 Skill 作用域。
 * @implementation 将智能体版本、安装项与工作树目录合成为继承上下文，并计算自动 Skill 的范围指纹。
 * @updated 2026-11-26T23:20:03+08:00
 */
import type { Session } from '../../../shared/types.js';
import type { AgentProfiles } from '../../agent-profiles.js';
import type { ProjectExtensions } from '../../extensions.js';
import { fingerprint } from '../../files.js';
import type { SkillInheritance } from '../../skill-inheritance.js';
import type { Store } from '../../store.js';

export function createSkillScope({
  store,
  agents,
  extensions,
  inheritance,
  nativeExecution,
  sessionDirectory,
}: {
  store: Pick<Store, 'get'>;
  agents: Pick<AgentProfiles, 'requireReady'>;
  extensions: Pick<ProjectExtensions, 'list'>;
  inheritance: Pick<SkillInheritance, 'snapshot'>;
  nativeExecution: boolean;
  sessionDirectory(session: Session): string;
}) {
  function context(
    projectId: string,
    session: Session | undefined,
    native: boolean,
    directory?: string,
    workspaceAutomatic = false,
  ) {
    const project = store.get('projects', projectId);
    const revision = session?.agentRevisionId
      ? agents.requireReady(projectId, session.agentRevisionId)
      : undefined;
    const all = extensions.list(projectId);
    const bound = revision && new Map(revision.config.skills.map((skill) => [skill.id, skill]));
    return {
      projectId,
      sessionId: session?.id,
      directory: directory ?? (session ? sessionDirectory(session) : project.path),
      native: native && nativeExecution && !session?.agentRevisionId,
      workspaceAutomatic:
        workspaceAutomatic && !native && Boolean(session) && !session?.agentRevisionId,
      installed: bound ? all.filter((item) => bound.get(item.id)?.version === item.version) : all,
      boundAuto:
        bound &&
        new Set(
          [...bound.values()].filter(({ activation }) => activation === 'auto').map(({ id }) => id),
        ),
    };
  }

  function automatic(
    scope: ReturnType<typeof context>,
    snapshot = inheritance.snapshot(scope, true),
  ) {
    return fingerprint(
      JSON.stringify(
        snapshot.view.items
          .filter(({ effective }) => effective === 'auto')
          .map(({ id, version }) => [id, version])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      ),
    );
  }

  return { context, automatic };
}

export type SkillScope = ReturnType<typeof createSkillScope>;
