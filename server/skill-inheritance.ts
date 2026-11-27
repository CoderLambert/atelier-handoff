/**
 * @file 计算并应用全局、项目和会话的 Skill 继承策略。
 * @implementation 汇总安装项与本机目录生成可用性快照，校验策略和手动选择，并按可选允许列表组装自动 Skill 与手动指令。
 * @updated 2026-11-27T02:25:28+08:00
 */
import {
  AppError,
  type Extension,
  type ExtensionSelection,
  type UsedExtension,
} from '../shared/types.js';
import type {
  SkillInheritanceItem,
  SkillInheritancePatch,
  SkillInheritanceView,
} from '../shared/skill-inheritance.js';
import { inspectMarkdown, type ExtensionBundle } from './extensions.js';
import {
  discoverHostSkills,
  discoverLocalSkills,
  discoverProjectMarkdownSkills,
  type LocalSkill,
} from './local-skill-catalog.js';
import { selectRunSkills, type RunSkill } from './run-skills.js';
import type { Store } from './store.js';

export type SkillContext = {
  projectId?: string;
  sessionId?: string;
  directory?: string;
  native: boolean;
  workspaceAutomatic?: boolean;
  installed?: Extension[];
  boundAuto?: ReadonlySet<string>;
};

export class SkillInheritance {
  constructor(
    private readonly policy: Store['skillInheritance'],
    private readonly home?: string,
  ) {}

  snapshot(context: SkillContext, forRun = false) {
    const {
      projectId,
      sessionId,
      directory,
      native,
      workspaceAutomatic,
      installed = [],
      boundAuto,
    } = context;
    const allowProjectMarkdown = Boolean(!native && workspaceAutomatic && !boundAuto);
    const enabled = this.policy.readGlobal();
    const projectMode = projectId ? this.policy.projectMode(projectId) : 'follow';
    const globalModes = this.policy.hostModes();
    const overrides = sessionId ? this.policy.sessionModes(sessionId) : undefined;
    const workspace = !directory
      ? []
      : native
        ? discoverLocalSkills('workspace', directory)
        : !forRun || allowProjectMarkdown
          ? discoverProjectMarkdownSkills(directory)
          : [];
    const host =
      !forRun || (native && enabled && projectMode === 'follow')
        ? discoverHostSkills(this.home)
        : [];
    const local = new Map([...workspace, ...host].map((skill) => [skill.id, skill]));
    const items: SkillInheritanceItem[] = [];
    for (const skill of installed) {
      if (skill.kind !== 'skill') continue;
      const meta = inspectMarkdown(skill.body, skill.package);
      const manual = skill.supported && skill.userInvocable;
      const auto = Boolean(
        (!boundAuto || boundAuto.has(skill.id)) &&
        meta.supported &&
        meta.modelInvocable &&
        (skill.description || meta.description).trim() &&
        /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(skill.name),
      );
      const mode = !skill.enabled
        ? 'off'
        : skill.autoInvoke !== false && auto
          ? 'auto'
          : manual
            ? 'manual'
            : 'off';
      items.push({
        id: skill.id,
        name: skill.name,
        description: skill.description || meta.description,
        version: skill.version,
        source: 'atelier',
        manual,
        auto,
        mode,
        ...effective(mode, overrides?.get(skill.id), mode === 'off' ? 'disabled' : undefined),
      });
    }
    for (const { id, source, name, description, version, auto, manual } of local.values()) {
      const mode =
        source === 'host'
          ? (globalModes.get(id) ?? 'off')
          : auto
            ? 'auto'
            : manual
              ? 'manual'
              : 'off';
      const unavailable =
        source === 'host' && !enabled
          ? 'global-off'
          : source === 'host' && projectMode === 'block'
            ? 'project-blocked'
            : !native && (source === 'host' ? projectId : !allowProjectMarkdown)
              ? 'not-native'
              : mode === 'off' || (mode === 'manual' && !manual) || (mode === 'auto' && !auto)
                ? 'disabled'
                : undefined;
      items.push({
        id,
        name,
        description,
        version,
        source,
        mode,
        auto,
        manual,
        ...effective(
          mode,
          overrides?.get(id) === 'manual' && !manual ? 'off' : overrides?.get(id),
          unavailable,
        ),
      });
    }
    const view: SkillInheritanceView = { enabled, projectMode, items };
    return { view, local };
  }

  update(context: SkillContext, patch: SkillInheritancePatch) {
    const invalid = () =>
      new AppError('EXTENSION_UNAVAILABLE', '该范围不允许使用或修改此 Skill。', 409);
    if (patch.type === 'global' && !context.projectId) this.policy.setGlobal(patch.enabled);
    else if (patch.type === 'project' && context.projectId && !context.sessionId)
      this.policy.setProjectMode(context.projectId, patch.mode);
    else if (patch.type === 'host' || patch.type === 'session') {
      const item = this.snapshot(context).view.items.find(({ id }) => id === patch.id);
      if (!item) throw invalid();
      if (patch.type === 'host' && !context.projectId && item.source === 'host') {
        if ((patch.mode === 'auto' && !item.auto) || (patch.mode === 'manual' && !item.manual))
          throw invalid();
        this.policy.setHostMode(item.id, patch.mode);
      } else if (patch.type === 'session' && context.sessionId) {
        if (patch.mode === 'manual' && (item.mode === 'off' || !item.manual)) throw invalid();
        this.policy.setSessionMode(context.sessionId, item.id, patch.mode);
      } else throw invalid();
    } else throw invalid();
    return this.snapshot(context).view;
  }
}

function effective(
  mode: SkillInheritanceItem['mode'],
  override: SkillInheritanceItem['override'] = 'follow',
  unavailable?: SkillInheritanceItem['reason'],
): Pick<SkillInheritanceItem, 'effective' | 'override' | 'reason'> {
  const reason = unavailable ?? (override === 'off' ? 'session-off' : undefined);
  return { effective: reason ? 'off' : override === 'manual' ? 'manual' : mode, override, reason };
}

type Snapshot = ReturnType<SkillInheritance['snapshot']>;

export function resolveSkillSelections(snapshot: Snapshot, selections: ExtensionSelection[]) {
  const project: ExtensionSelection[] = [];
  const local: LocalSkill[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    const discovered = snapshot.local.get(selection.id);
    if (!discovered) {
      project.push(selection);
      continue;
    }
    if (seen.has(selection.id)) continue;
    seen.add(selection.id);
    const item = snapshot.view.items.find(({ id }) => id === selection.id);
    if (
      !item ||
      item.effective === 'off' ||
      !item.manual ||
      item.version !== selection.version ||
      selection.tools !== undefined
    )
      throw new AppError('EXTENSION_CHANGED', '所选 Skill 已停用或内容已更新，请重新选择。', 409);
    local.push(discovered);
  }
  return { project, local };
}

export function applySkillScope(
  snapshot: Snapshot,
  bundle: ExtensionBundle,
  installed: Extension[],
  local: LocalSkill[],
  requestText: string,
  allowedSkillIds?: ReadonlySet<string>,
) {
  const items = new Map(snapshot.view.items.map((item) => [item.id, item]));
  const isAutomatic = (id: string) =>
    items.get(id)?.effective === 'auto' && (allowedSkillIds?.has(id) ?? true);
  for (const ref of bundle.used) {
    if (ref.kind === 'skill' && items.get(ref.id)?.effective === 'off')
      throw new AppError('EXTENSION_CHANGED', '所选 Skill 已停用，请重新选择。', 409);
  }
  const skills = selectRunSkills(
    installed.filter(({ id }) => isAutomatic(id) || bundle.used.some((ref) => ref.id === id)),
    bundle.used,
  );
  for (const skill of snapshot.local.values()) {
    if (
      !isAutomatic(skill.id) ||
      (skill.projectMarkdown && local.some(({ id }) => id === skill.id))
    )
      continue;
    skills.push({
      ...localReference(skill),
      kind: 'skill',
      description: skill.description,
      text: skill.text,
      local: skill,
    } satisfies RunSkill);
  }
  const localInstructions = local.map((skill) => {
    const label = `Skill ${skill.source}-skills:${skill.slug}`;
    const body = skill.projectMarkdown
      ? skill.text
      : skill.text.replaceAll('${CLAUDE_SKILL_DIR}', () => skill.directory);
    const text = body.replace(/\$ARGUMENTS|\$0|\$1|\$2|\$3/gu, (match) => {
      if (match === '$ARGUMENTS') return requestText;
      return requestText.split(/\s+/u)[Number(match.slice(1))] ?? '';
    });
    return skill.projectMarkdown
      ? `${label}（仅 Markdown 正文，不提供附属文件）：\n${text}`
      : `${label}（附属文件目录：${skill.directory}）：\n${text}`;
  });
  const used = [...bundle.used, ...local.map(localReference)];
  return { skills, used, prompt: [...localInstructions, bundle.prompt].join('\n\n') };
}

function localReference({ id, name, version, source }: LocalSkill): UsedExtension {
  return { id, kind: 'skill', name, version, source };
}
