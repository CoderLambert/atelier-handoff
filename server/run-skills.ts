import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Extension, SkillPackage, UsedExtension } from '../shared/types.js';
import { inspectMarkdown } from './extensions.js';

const pluginName = 'atelier-skills';
export type RunSkill = UsedExtension & {
  kind: 'skill';
  description: string;
  text: string;
  package?: SkillPackage;
  manual?: boolean;
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
      },
    ];
  });
}

export function sdkSkillName(skill: RunSkill) {
  return `${pluginName}:${skill.name}`;
}

export async function mountRunSkills(sdkDirectory: string, skills: RunSkill[]) {
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
