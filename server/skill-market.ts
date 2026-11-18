import { z } from 'zod';
import { AppError } from '../shared/types.js';
import { ProjectExtensions, validateMarketEntry } from './extensions.js';
import { previewPublic } from './public-extensions.js';
import {
  identifyMarketSkill,
  marketCurrent,
  marketLocalModified,
  marketSkillById,
  skillMarketCatalog,
  type MarketSkill,
} from './skill-market-catalog.js';

function requireSkill(id: string, revision?: string) {
  const skill = marketSkillById(id);
  if (!skill) throw new AppError('MARKET_SKILL_NOT_FOUND', '精选目录中没有该 Skill。', 404);
  if (revision !== undefined && revision !== skill.revision)
    throw new AppError('MARKET_CATALOG_CHANGED', '精选目录已更新，请刷新并重新预览。', 409);
  return skill;
}

export function listSkillMarket(registry: ProjectExtensions, projectId: string) {
  const items = registry.list(projectId);
  return skillMarketCatalog.map((skill) => {
    const matches = items.filter((item) => identifyMarketSkill(item)?.id === skill.id);
    const installed = matches[0];
    const conflict =
      matches.length > 1 ||
      (!installed && items.some((item) => item.kind !== 'mcp' && item.name === skill.name));
    const localModified = installed ? marketLocalModified(skill, installed) : false;
    const legacy = Boolean(installed && !installed.marketRevision);
    const updateAvailable = Boolean(installed && !marketCurrent(skill, installed));
    return {
      id: skill.id,
      name: installed?.name ?? skill.name,
      title: skill.title,
      category: skill.category,
      description: skill.description,
      publisher: skill.publisher,
      url: skill.url,
      repository: skill.repository,
      path: skill.path,
      upstreamName: skill.upstreamName,
      commit: skill.commit,
      sha256: skill.sha256,
      revision: skill.revision,
      license: skill.license,
      capabilities: skill.capabilities,
      status: conflict
        ? 'conflict'
        : localModified
          ? 'local-modified'
          : legacy
            ? 'legacy'
            : updateAvailable
              ? 'update-available'
              : installed
                ? installed.enabled
                  ? 'enabled'
                  : 'disabled'
                : 'available',
      enabled: installed?.enabled,
      installedId: installed?.id,
      installedVersion: installed?.version,
      installedRevision: installed?.marketRevision ?? installed?.origin?.revision,
      localModified,
      legacy,
      updateAvailable,
    };
  });
}

async function fetchMarketSkill(skill: MarketSkill, fetchSkill: typeof previewPublic) {
  const entries = await fetchSkill(skill.url, 'skill');
  const entry = entries[0];
  if (entries.length !== 1 || !entry)
    throw new AppError('MARKET_SKILL_SOURCE_CHANGED', '精选来源未返回唯一的 Skill 文件。', 409);
  validateMarketEntry(skill, entry);
  return entry;
}

export async function installMarketSkill(
  registry: ProjectExtensions,
  projectId: string,
  id: string,
  fetchSkill = previewPublic,
  revision?: string,
) {
  const skill = requireSkill(id, revision);
  const existing = registry.activateMarket(projectId, skill);
  if (existing) return existing;
  const card = listSkillMarket(registry, projectId).find((item) => item.id === id)!;
  if (card.status === 'conflict')
    throw new AppError(
      'EXTENSION_NAME_TAKEN',
      `当前项目已有 /${skill.name}，请先为同名扩展改名，再安装此 Skill。`,
      409,
    );
  const entry = await fetchMarketSkill(skill, fetchSkill);
  return registry.saveMarket(projectId, skill, entry);
}

export async function previewMarketSkill(
  registry: ProjectExtensions,
  projectId: string,
  id: string,
  fetchSkill = previewPublic,
) {
  const skill = requireSkill(id);
  registry.list(projectId);
  const entry = await fetchMarketSkill(skill, fetchSkill);
  const card = listSkillMarket(registry, projectId).find((item) => item.id === id)!;
  if (card.status === 'conflict')
    throw new AppError('MARKET_SKILL_CONFLICT', '请先处理项目中的同名或重复 Skill 记录。', 409);
  const installed = card.installedId ? registry.get(projectId, card.installedId) : undefined;
  return {
    skill: card,
    entry,
    update: installed
      ? { id: installed.id, version: installed.version, revision: skill.revision }
      : undefined,
    localBody: installed?.kind === 'skill' ? installed.body : undefined,
    requiresReplacement: card.localModified,
  };
}

export async function updateMarketSkill(
  registry: ProjectExtensions,
  projectId: string,
  id: string,
  raw: { id: string; version: number; revision: string; replaceLocal?: boolean },
  fetchSkill = previewPublic,
) {
  const update = z
    .object({
      id: z.string().uuid(),
      version: z.number().int().positive(),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      replaceLocal: z.boolean().optional(),
    })
    .parse(raw);
  const skill = requireSkill(id, update.revision);
  const previous = registry.get(projectId, update.id);
  if (identifyMarketSkill(previous)?.id !== skill.id || previous.version !== update.version)
    throw new AppError('EXTENSION_CHANGED', '项目 Skill 已变化，请重新预览后更新。', 409);
  if (marketLocalModified(skill, previous) && !update.replaceLocal)
    throw new AppError(
      'MARKET_LOCAL_MODIFIED',
      '此 Skill 包含本地修改，请先复制或保存正文，再明确选择替换本地修改。',
      409,
    );
  const entry = await fetchMarketSkill(skill, fetchSkill);
  return registry.saveMarket(projectId, skill, entry, update);
}
