/**
 * @file 发现本机用户目录和工作区中的 Claude Skills。
 * @implementation 有界读取并解析 SKILL.md，根据来源和路径生成稳定标识、根据内容生成版本，跳过不可读取或无效项。
 * @updated 2026-11-26T00:06:59+08:00
 */
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectMarkdown } from './extensions.js';
import type { SkillInheritanceItem } from '../shared/skill-inheritance.js';

export type LocalSkill = Pick<
  SkillInheritanceItem,
  'id' | 'name' | 'description' | 'version' | 'manual' | 'auto'
> & {
  source: 'host' | 'workspace';
  directory: string;
  slug: string;
  document: string;
  text: string;
};

const limit = 256 * 1024;
const skillName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;

function skillDocument(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) return;
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > limit || bytes !== info.size) return;
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function stableId(parts: readonly string[]) {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function discoverLocalSkills(source: LocalSkill['source'], root: string) {
  const catalog = join(root, '.claude', 'skills');
  let names: string[];
  try {
    names = readdirSync(catalog)
      .filter((name) => skillName.test(name))
      .sort();
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'ENOTDIR'].includes(String(error.code))
    )
      return [];
    throw error;
  }
  return names.flatMap((slug): LocalSkill[] => {
    const path = join(catalog, slug, 'SKILL.md');
    try {
      const resolved = realpathSync(path);
      const document = skillDocument(resolved);
      if (!document) return [];
      const metadata = inspectMarkdown(document, undefined, true);
      const name = metadata.name && skillName.test(metadata.name) ? metadata.name : slug;
      const directory = realpathSync(dirname(path));
      return [
        {
          id: stableId([source, root, slug, resolved]),
          version: createHash('sha256').update(document).digest().readUIntBE(0, 6) + 1,
          source,
          slug,
          name,
          directory,
          document,
          description: metadata.description,
          text: metadata.text,
          auto: metadata.modelInvocable && Boolean(metadata.text),
          manual: metadata.userInvocable && metadata.supported && !metadata.text.includes('!`'),
        },
      ];
    } catch {
      // A single unreadable, deleted, or malformed target is not available to the SDK.
      return [];
    }
  });
}

export function discoverHostSkills(home = homedir()) {
  return discoverLocalSkills('host', home);
}
