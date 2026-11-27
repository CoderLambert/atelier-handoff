/**
 * @file 发现本机用户目录和工作区中的 Claude Skills。
 * @implementation 区分原生发现与受控项目的无链接 Markdown 快照，有界读取并生成稳定标识和内容版本。
 * @updated 2026-11-27T02:25:28+08:00
 */
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
  projectMarkdown?: true;
};

const limit = 256 * 1024;
const skillName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;

function skillDocument(path: string, strict = false): string | undefined {
  let fd: number | undefined;
  try {
    const before = strict ? lstatSync(path) : undefined;
    if (before && (!before.isFile() || before.nlink !== 1 || before.size > limit)) return;
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (strict ? constants.O_NOFOLLOW : 0),
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) return;
    if (before && (info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino)) return;
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > limit || bytes !== info.size) return;
    const content = buffer.subarray(0, bytes);
    if (strict && content.includes(0)) return;
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
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

function localSkill(
  source: LocalSkill['source'],
  root: string,
  slug: string,
  directory: string,
  path: string,
  document: string,
  strict = false,
): LocalSkill {
  const metadata = inspectMarkdown(document, undefined, !strict);
  const name = metadata.name && skillName.test(metadata.name) ? metadata.name : slug;
  const supported =
    metadata.supported &&
    !metadata.text.includes('!`') &&
    (!strict || !metadata.text.includes('```!'));
  return {
    id: stableId([source, root, slug, path]),
    version: createHash('sha256').update(document).digest().readUIntBE(0, 6) + 1,
    source,
    slug,
    name,
    directory,
    document,
    description: metadata.description,
    text: metadata.text,
    auto:
      metadata.modelInvocable &&
      Boolean(metadata.text) &&
      (!strict || (supported && !/!`|```!/u.test(metadata.description))),
    manual: metadata.userInvocable && supported,
    ...(strict ? { projectMarkdown: true } : {}),
  };
}

function withDirectory<T>(path: string, use: (fdPath: string) => T): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return use(`/proc/self/fd/${fd}`);
  } finally {
    closeSync(fd);
  }
}

export function discoverProjectMarkdownSkills(root: string): LocalSkill[] {
  // Node has no portable openat. Fail closed when descriptor-relative traversal is unavailable.
  if (process.platform !== 'linux' || !isAbsolute(root) || resolve(root) !== root) return [];
  try {
    return withDirectory(root, (project) => {
      if (realpathSync(project) !== root) return [];
      return withDirectory(join(project, '.claude'), (claude) =>
        withDirectory(join(claude, 'skills'), (catalog) =>
          readdirSync(catalog)
            .filter((name) => skillName.test(name))
            .sort()
            .flatMap((slug): LocalSkill[] => {
              try {
                return withDirectory(join(catalog, slug), (skill) => {
                  const document = skillDocument(join(skill, 'SKILL.md'), true);
                  if (!document) return [];
                  const directory = join(root, '.claude', 'skills', slug);
                  return [
                    localSkill(
                      'workspace',
                      root,
                      slug,
                      directory,
                      join(directory, 'SKILL.md'),
                      document,
                      true,
                    ),
                  ];
                });
              } catch {
                return [];
              }
            }),
        ),
      );
    });
  } catch {
    return [];
  }
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
      return [localSkill(source, root, slug, realpathSync(dirname(path)), resolved, document)];
    } catch {
      // A single unreadable, deleted, or malformed target is not available to the SDK.
      return [];
    }
  });
}

export function discoverHostSkills(home = homedir()) {
  return discoverLocalSkills('host', home);
}
