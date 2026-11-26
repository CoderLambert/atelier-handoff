/**
 * @file 准备运行所需的 Skill 及 SDK 临时插件。
 * @implementation 筛选已安装 Skill，并分别为安装项和本机目录项创建临时插件；失败时清理已创建目录。
 * @updated 2026-11-26T00:06:59+08:00
 */
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Extension, SkillPackage, UsedExtension } from '../shared/types.js';
import { inspectMarkdown } from './extensions.js';
import type { LocalSkill } from './local-skill-catalog.js';
import { writeSkillPackage } from './skill-package-runtime.js';

const pluginName = 'atelier-skills';
export type RunSkill = UsedExtension & {
  kind: 'skill';
  description: string;
  text: string;
  package?: SkillPackage;
  manual?: boolean;
  nativePackage?: boolean;
  local?: LocalSkill;
};

export function selectRunSkills(installed: Extension[], selected: UsedExtension[]): RunSkill[] {
  const explicit = new Set(selected.map((item) => item.id));
  return installed.flatMap((item) => {
    if (item.kind !== 'skill' || !item.enabled) return [];
    const manual = explicit.has(item.id);
    if (manual ? !item.package : item.autoInvoke === false) return [];
    const metadata = inspectMarkdown(item.body, item.package);
    // Keep SDK command names exact and filesystem-safe, even for old stored records.
    const description = item.description || metadata.description;
    if (
      !metadata.supported ||
      (!manual && !metadata.modelInvocable) ||
      (!manual && !description.trim()) ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.name)
    )
      return [];
    return [
      {
        id: item.id,
        kind: 'skill',
        name: item.name,
        version: item.version,
        description,
        text: metadata.text,
        ...(item.package ? { package: item.package } : {}),
        ...(manual ? { manual: true } : {}),
        ...(item.origin?.github ? { nativePackage: true } : {}),
      },
    ];
  });
}

export function sdkSkillName(skill: RunSkill) {
  return skill.local
    ? `${skill.local.source}-skills:${skill.local.slug}`
    : `${pluginName}:${skill.name}`;
}

export async function mountLocalRunSkills(sdkDirectory: string, skills: RunSkill[]) {
  const directories: string[] = [];
  try {
    for (const source of ['host', 'workspace'] as const) {
      const locals = skills.flatMap(({ local }) => (local?.source === source ? [local] : []));
      if (!locals.length) continue;
      const name = `${source}-skills`;
      const root = await mkdtemp(join(sdkDirectory, `${name}-`));
      directories.push(root);
      const manifest = join(root, '.claude-plugin');
      await mkdir(manifest, { mode: 0o700 });
      await writeFile(join(manifest, 'plugin.json'), JSON.stringify({ name }), { mode: 0o600 });
      for (const skill of locals) {
        const destination = join(root, 'skills', skill.slug);
        await mkdir(destination, { recursive: true, mode: 0o700 });
        await writeFile(join(destination, 'SKILL.md'), skill.document, { mode: 0o600, flag: 'wx' });
        const entries = await readdir(skill.directory, { withFileTypes: true });
        for (const entry of entries) {
          if (
            entry.name === 'SKILL.md' ||
            !(entry.isFile() || entry.isDirectory() || entry.isSymbolicLink())
          )
            continue;
          await symlink(
            join(skill.directory, entry.name),
            join(destination, entry.name),
            entry.isDirectory() ? 'dir' : undefined,
          );
        }
      }
    }
    return directories;
  } catch (error) {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    throw error;
  }
}

export async function mountRunSkills(sdkDirectory: string, skills: RunSkill[], native = false) {
  const directory = await mkdtemp(join(sdkDirectory, 'skills-'));
  try {
    const manifest = join(directory, '.claude-plugin');
    await mkdir(manifest, { mode: 0o700 });
    await writeFile(join(manifest, 'plugin.json'), JSON.stringify({ name: pluginName }), {
      mode: 0o600,
    });
    for (const skill of skills) {
      const destination = join(directory, 'skills', skill.name);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      if (native && skill.nativePackage && skill.package)
        await writeSkillPackage(destination, skill.package, true);
      // Imported frontmatter must not configure tools, hooks, models, or other SDK behavior.
      const document = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.text}\n`;
      await writeFile(join(destination, 'SKILL.md'), document, { mode: 0o600, flag: 'wx' });
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function mountManualSkillPackages(sdkDirectory: string, skills: RunSkill[]) {
  const directory = await mkdtemp(join(sdkDirectory, 'skill-packages-'));
  try {
    for (const skill of skills) {
      if (!skill.package) continue;
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(skill.name)) throw new Error('Invalid installed Skill name');
      await writeSkillPackage(join(directory, skill.name), skill.package);
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
