import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AppError,
  agentCapabilities,
  now,
  type AgentCard,
  type AgentConfig,
  type AgentProfile,
  type AgentRevision,
  type AgentSessionInfo,
  type Extension,
} from '../shared/types.js';
import { inspectMarkdown, ProjectExtensions } from './extensions.js';
import { Store } from './store.js';

const nameLimit = 80;
const version = z.number().int().positive();
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const agentConfig = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(nameLimit)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
    description: z.string().trim().max(1000).default(''),
    instructions: z.string().trim().min(1).max(32000),
    starters: z.array(z.string().trim().min(1).max(4000)).max(3).default([]),
    mode: z.enum(['readonly', 'edit']).default('readonly'),
    capabilities: z.array(z.enum(agentCapabilities)).refine(unique).default([]),
    skills: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            version,
            activation: z.enum(['auto', 'manual']),
          })
          .strict(),
      )
      .max(12)
      .refine((items) => unique(items.map((item) => item.id)))
      .default([]),
    mcp: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            version,
            tools: z.array(toolName).min(1).max(40).refine(unique),
          })
          .strict(),
      )
      .max(12)
      .refine((items) => unique(items.map((item) => item.id)))
      .default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (
      config.mode === 'readonly' &&
      config.capabilities.some((capability) => capability === 'write' || capability === 'command')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: '文件修改和命令能力需要受控修改模式。',
      });
  });
const updateInput = z.object({ baseRevisionId: z.string().uuid(), config: agentConfig }).strict();
const dependenciesSchema = z
  .object({
    skills: z.array(
      z
        .object({
          id: z.string().uuid(),
          version,
          name: z.string(),
          description: z.string(),
          body: z.string(),
          activation: z.enum(['auto', 'manual']),
        })
        .strict(),
    ),
    mcp: z.array(
      z
        .object({
          id: z.string().uuid(),
          version,
          name: z.string(),
          description: z.string(),
          transportType: z.enum(['http', 'stdio']),
          transportDigest: z.string().regex(/^[a-f0-9]{64}$/),
          tools: z.array(
            z
              .object({
                name: toolName,
                description: z.string(),
                inputSchema: z.record(z.string(), z.unknown()).optional(),
                access: z.enum(['read', 'approval']),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export type AgentDependencies = z.infer<typeof dependenciesSchema>;

// JSON is the persistence boundary. Sort object keys so metadata property order does not
// invalidate a reviewed dependency; array order (notably stdio arguments) remains significant.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
        )
      : item,
  );
}
function normalizedName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

export class AgentProfiles {
  constructor(
    private store: Store,
    private extensions: ProjectExtensions,
  ) {}

  list(projectId: string): AgentCard[] {
    const catalog = this.extensions.list(projectId);
    return this.store
      .list('agents')
      .filter((profile) => profile.projectId === projectId)
      .map((profile) => this.profileCard(profile, catalog))
      .sort((left, right) => left.config.name.localeCompare(right.config.name));
  }

  create(projectId: string, raw: unknown): AgentCard {
    const config: AgentConfig = agentConfig.parse(raw);
    if (config.mode !== 'readonly')
      throw new AppError('AGENT_MODE_DENIED', '新建智能体请先使用只读模式。', 403);
    return this.store.transaction(() => {
      const catalog = this.extensions.list(projectId);
      this.requireUniqueName(projectId, config.name);
      const { dependencies, issues } = this.snapshot(config, catalog);
      this.requireAvailable(issues);
      return this.insert(projectId, config, dependencies, catalog);
    });
  }

  update(projectId: string, id: string, raw: unknown): AgentCard {
    const input = updateInput.parse(raw);
    return this.store.transaction(() => {
      const profile = this.current(projectId, id, input.baseRevisionId);
      this.requireActive(profile);
      const previous = this.revision(projectId, profile.revisionId);
      const catalog = this.extensions.list(projectId);
      this.requireUniqueName(projectId, input.config.name, id);
      const { dependencies, issues } = this.snapshot(input.config, catalog);
      this.requireAvailable(issues);
      const revision: AgentRevision = {
        id: randomUUID(),
        agentId: id,
        projectId,
        version: previous.version + 1,
        config: input.config,
        dependencies,
        createdAt: now(),
      };
      this.store.put('agentRevisions', revision);
      const updated = this.store.update('agents', id, {
        revisionId: revision.id,
        updatedAt: revision.createdAt,
      });
      return this.profileCard(updated, catalog);
    });
  }

  archive(projectId: string, id: string, baseRevisionId: string): AgentCard {
    return this.store.transaction(() => {
      const profile = this.current(projectId, id, baseRevisionId);
      const archived = profile.archived
        ? profile
        : this.store.update('agents', id, { archived: true, updatedAt: now() });
      return this.profileCard(archived, this.extensions.list(projectId));
    });
  }

  duplicate(projectId: string, id: string, baseRevisionId: string): AgentCard {
    return this.store.transaction(() => {
      const profile = this.current(projectId, id, baseRevisionId);
      const revision = this.revision(projectId, profile.revisionId);
      const names = new Set(
        this.store
          .list('agents')
          .filter((item) => item.projectId === projectId && !item.archived)
          .map((item) => normalizedName(this.revision(projectId, item.revisionId).config.name)),
      );
      let name: string;
      let number = 1;
      do {
        const suffix = number === 1 ? '（副本）' : `（副本 ${number}）`;
        name = revision.config.name.slice(0, nameLimit - suffix.length).trimEnd() + suffix;
        number++;
      } while (names.has(normalizedName(name)));
      // Copy the reviewed historical snapshot even when an extension was removed. The
      // resulting card exposes its issues and can be repaired through a new publication.
      return this.insert(
        projectId,
        { ...revision.config, name },
        revision.dependencies,
        this.extensions.list(projectId),
      );
    });
  }

  card(projectId: string, id: string): AgentCard {
    const profile = this.profile(projectId, id);
    return this.profileCard(profile, this.extensions.list(projectId));
  }

  revision(projectId: string, revisionId: string): AgentRevision {
    this.store.get('projects', projectId);
    const revision = this.store.get('agentRevisions', revisionId);
    if (revision.projectId !== projectId)
      throw new AppError('NOT_FOUND', '智能体版本不存在。', 404);
    const profile = this.profile(projectId, revision.agentId);
    if (profile.projectId !== revision.projectId)
      throw new AppError('NOT_FOUND', '智能体版本不存在。', 404);
    return revision;
  }

  requireReady(projectId: string, revisionId: string): AgentRevision {
    const revision = this.revision(projectId, revisionId);
    this.requireActive(this.profile(projectId, revision.agentId));
    this.requireAvailable(this.issues(revision, this.extensions.list(projectId)));
    return revision;
  }

  binding(revision: AgentRevision): AgentSessionInfo {
    const profile = this.profile(revision.projectId, revision.agentId);
    return {
      id: revision.agentId,
      revisionId: revision.id,
      name: revision.config.name,
      version: revision.version,
      capabilities: revision.config.capabilities,
      mode: revision.config.mode,
      starters: revision.config.starters,
      skills: revision.config.skills,
      mcp: revision.config.mcp,
      issues: [
        ...(profile.archived ? ['智能体已归档。'] : []),
        ...this.issues(revision, this.extensions.list(revision.projectId)),
      ],
    };
  }

  private profile(projectId: string, id: string): AgentProfile {
    this.store.get('projects', projectId);
    const profile = this.store.get('agents', id);
    if (profile.projectId !== projectId) throw new AppError('NOT_FOUND', '项目智能体不存在。', 404);
    return profile;
  }

  private current(projectId: string, id: string, baseRevisionId: string): AgentProfile {
    const profile = this.profile(projectId, id);
    if (profile.revisionId !== z.string().uuid().parse(baseRevisionId))
      throw new AppError('AGENT_CHANGED', '智能体配置已更新，请刷新后重新编辑。', 409);
    return profile;
  }

  private requireActive(profile: AgentProfile): void {
    if (profile.archived)
      throw new AppError('AGENT_ARCHIVED', '智能体已归档，请复制后再使用。', 409);
  }

  private requireUniqueName(projectId: string, name: string, exceptId?: string): void {
    if (
      this.store
        .list('agents')
        .some(
          (profile) =>
            profile.projectId === projectId &&
            !profile.archived &&
            profile.id !== exceptId &&
            normalizedName(this.revision(projectId, profile.revisionId).config.name) ===
              normalizedName(name),
        )
    )
      throw new AppError('AGENT_NAME_TAKEN', '当前项目已有同名智能体。', 409);
  }

  private insert(
    projectId: string,
    config: AgentConfig,
    dependencies: unknown,
    catalog: Extension[],
  ): AgentCard {
    const id = randomUUID();
    const at = now();
    const revision: AgentRevision = {
      id: randomUUID(),
      agentId: id,
      projectId,
      version: 1,
      config,
      dependencies,
      createdAt: at,
    };
    this.store.put('agentRevisions', revision);
    const profile = this.store.put('agents', {
      id,
      projectId,
      revisionId: revision.id,
      archived: false,
      createdAt: at,
      updatedAt: at,
    });
    return this.profileCard(profile, catalog);
  }

  private profileCard(profile: AgentProfile, catalog: Extension[]): AgentCard {
    const revision = this.revision(profile.projectId, profile.revisionId);
    if (revision.agentId !== profile.id) throw new AppError('NOT_FOUND', '智能体版本不存在。', 404);
    return {
      id: profile.id,
      projectId: profile.projectId,
      revisionId: revision.id,
      archived: profile.archived,
      version: revision.version,
      config: revision.config,
      issues: [...(profile.archived ? ['智能体已归档。'] : []), ...this.issues(revision, catalog)],
    };
  }

  private requireAvailable(issues: string[]): void {
    if (issues.length) throw new AppError('AGENT_UNAVAILABLE', issues.join('\n'), 409);
  }

  private issues(revision: AgentRevision, catalog: Extension[]): string[] {
    const current = this.snapshot(revision.config, catalog);
    const saved = dependenciesSchema.safeParse(revision.dependencies);
    if (!saved.success) return [...current.issues, '智能体依赖的历史快照无效，请重新发布配置。'];
    for (const kind of ['skills', 'mcp'] as const) {
      for (const dependency of current.dependencies[kind]) {
        const previous = saved.data[kind].find((item) => item.id === dependency.id);
        if (canonical(previous) !== canonical(dependency))
          current.issues.push(
            `${kind === 'skills' ? 'Skill' : 'MCP'} ${dependency.name} 的内容或授权已变化，请重新选择并发布新版本。`,
          );
      }
      if (
        saved.data[kind].length !== revision.config[kind].length ||
        saved.data[kind].some(
          (item) => !revision.config[kind].some((reference) => reference.id === item.id),
        )
      )
        current.issues.push('智能体依赖的历史快照与配置不一致，请重新发布配置。');
    }
    return [...new Set(current.issues)];
  }

  private snapshot(
    config: AgentConfig,
    catalog: Extension[],
  ): { dependencies: AgentDependencies; issues: string[] } {
    const dependencies: AgentDependencies = { skills: [], mcp: [] };
    const issues: string[] = [];
    const installed = new Map(catalog.map((item) => [item.id, item]));
    for (const reference of config.skills) {
      const item = installed.get(reference.id);
      if (!item || item.kind !== 'skill') {
        issues.push(`Skill ${reference.id} 已移除或不属于当前项目。`);
        continue;
      }
      if (!item.enabled || item.version !== reference.version)
        issues.push(`Skill ${item.name} 已停用或更新，请重新选择。`);
      const metadata = inspectMarkdown(item.body);
      const description = item.description || metadata.description;
      if (!item.supported || !metadata.supported)
        issues.push(`Skill ${item.name} 的内容不兼容，请检查扩展配置。`);
      if (reference.activation === 'manual' && (!item.userInvocable || !metadata.userInvocable))
        issues.push(`Skill ${item.name} 不允许手动调用。`);
      if (
        reference.activation === 'auto' &&
        (item.autoInvoke === false ||
          item.modelInvocable === false ||
          !metadata.modelInvocable ||
          !description.trim() ||
          !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.name))
      )
        issues.push(`Skill ${item.name} 当前不允许按需调用或缺少用途描述。`);
      dependencies.skills.push({
        id: item.id,
        version: item.version,
        name: item.name,
        description,
        body: item.body,
        activation: reference.activation,
      });
    }
    for (const reference of config.mcp) {
      const item = installed.get(reference.id);
      if (!item || item.kind !== 'mcp') {
        issues.push(`MCP ${reference.id} 已移除或不属于当前项目。`);
        continue;
      }
      if (!item.enabled || item.version !== reference.version)
        issues.push(`MCP ${item.name} 已停用或更新，请重新选择。`);
      const tools: AgentDependencies['mcp'][number]['tools'] = [];
      for (const name of reference.tools) {
        const tool = item.tools.find((entry) => entry.name === name);
        const allowed = item.allowedTools.find((entry) => entry.name === name);
        if (!tool || !allowed) {
          issues.push(`MCP ${item.name} 的工具 ${name} 已移除或撤销授权。`);
          continue;
        }
        if (config.mode === 'readonly' && allowed.access !== 'read')
          issues.push(`MCP ${item.name} 的工具 ${name} 需要受控修改模式。`);
        tools.push({
          name,
          description: tool.description,
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
          access: allowed.access,
        });
      }
      // Never store transport arguments, endpoints, or environment values in a revision.
      // Hashing the server-side transport still detects connection or credential-ref changes.
      dependencies.mcp.push({
        id: item.id,
        version: item.version,
        name: item.name,
        description: item.description,
        transportType: item.transport.type,
        transportDigest: createHash('sha256').update(canonical(item.transport)).digest('hex'),
        tools,
      });
    }
    return { dependencies, issues };
  }
}
