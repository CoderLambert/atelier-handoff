/**
 * @file 发现和下载公开 GitHub Skill。
 * @implementation 解析跟踪来源，按固定提交构建目录清单，并验证每个文件的 Git blob 哈希。
 * @updated 2026-11-26T12:00:00+08:00
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import type { GithubSkillVersion, PublicEntry } from '../shared/public-extensions.js';
import { AppError, type SkillPackage } from '../shared/types.js';
import { inspectMarkdown } from './extensions.js';
import { fingerprint } from './files.js';
import { skillPackageLimits as limits } from './skill-package.js';

const oid = z.string().regex(/^[a-f0-9]{40}$/);
const treeEntry = z.object({
  path: z.string().min(1),
  mode: z.string(),
  type: z.enum(['blob', 'tree', 'commit']),
  sha: oid,
  size: z.number().int().nonnegative().optional(),
});
const gitTree = z.object({ sha: oid, truncated: z.boolean(), tree: z.array(treeEntry) });
const gitCommit = z.object({ sha: oid, commit: z.object({ tree: z.object({ sha: oid }) }) });
type TreeEntry = z.infer<typeof treeEntry>;
type PackageFile = { path: string; size: number; sha: string; executable: boolean };
type Located = GithubSkillVersion & { tree: string };

const invalid = () =>
  new AppError('PUBLIC_SOURCE_INVALID', '请输入公开 GitHub 仓库、目录或 SKILL.md 的 HTTPS 链接。');
const missing = () =>
  new AppError('GITHUB_SKILL_NOT_FOUND', '找不到链接指向的 GitHub 分支、目录或 SKILL.md。', 404);
const unsupported = () =>
  new AppError('GITHUB_SKILL_UNSUPPORTED', '技能目录包含不安全的路径、链接或非普通文件。', 422);
const changed = () =>
  new AppError('PUBLIC_SOURCE_CHANGED', '公开来源版本或校验信息已变化，请重新预览。', 409);
const tooLarge = () =>
  new AppError('PUBLIC_SOURCE_TOO_LARGE', '公开文件超过读取上限，请缩小范围或指定单个文件。', 413);
const truncated = () =>
  new AppError(
    'GITHUB_SKILL_TRUNCATED',
    'GitHub 目录结果不完整，请使用更具体的 GitHub 目录或 SKILL.md 链接。',
    422,
  );

const urlPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const isSkill = (path: string) => /^skill\.md$/i.test(posix.basename(path));
const directoryOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const hash = (algorithm: string, bytes: Buffer) =>
  createHash(algorithm).update(bytes).digest('hex');

function sourceLocation(value: string) {
  let url: URL;
  let segments: string[];
  try {
    url = new URL(value);
    segments = url.pathname
      .replace(/^\/|\/$/g, '')
      .split('/')
      .map(decodeURIComponent);
  } catch {
    throw invalid();
  }
  const raw = url.hostname === 'raw.githubusercontent.com';
  const [owner, rawRepo, page, ...tail] = segments;
  const repo = rawRepo?.replace(/\.git$/i, '');
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    (!raw && url.hostname !== 'github.com') ||
    !owner ||
    !/^[\w-]+$/.test(owner) ||
    !repo ||
    !/^[\w.-]+$/.test(repo) ||
    ['.', '..'].includes(repo) ||
    (raw ? !page || !tail.length : page && (!['tree', 'blob'].includes(page) || !tail.length))
  )
    throw invalid();
  const parts = raw ? [page, ...tail] : tail;
  if (
    parts.length > 32 ||
    parts.some(
      (part) =>
        !part ||
        /[\\\u0000-\u001f\u007f]/u.test(part) ||
        part.split('/').some((segment) => !segment || segment === '.' || segment === '..'),
    )
  )
    throw invalid();
  const file = raw || page === 'blob';
  if (file && !isSkill(parts.at(-1) ?? '')) throw invalid();
  return { owner, repo, parts, file };
}

function candidates(source: ReturnType<typeof sourceLocation>) {
  const { parts, file } = source;
  if (!parts.length) return [{ ref: 'HEAD', path: '' }];
  // An encoded ref is unambiguous. Otherwise GitHub URLs can put slash-separated refs in the path.
  const count = parts[0]?.includes('/') ? 1 : parts.length - Number(file);
  return Array.from({ length: count }, (_, index) => {
    const length = index + 1;
    return { ref: parts.slice(0, length).join('/'), path: parts.slice(length).join('/') };
  }).filter(({ ref, path }) => ref.length <= 1024 && path.length <= 1024);
}

async function bytesOf(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw changed();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

function assertPackagePath(path: string) {
  if (
    Buffer.byteLength(path) > 1024 ||
    path.normalize('NFC') !== path ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /^\.git$/i.test(part) ||
          /[<>:"\\|?*\u0000-\u001f\u007f]|[. ]$/u.test(part) ||
          Buffer.byteLength(part) > 255 ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
      )
  )
    throw unsupported();
}

function packageFiles(entries: TreeEntry[], manifest: string): PackageFile[] {
  if (entries.length > limits.entries) throw tooLarge();
  const paths = new Map<string, string>();
  const kinds = new Map<string, boolean>();
  let expanded = 0;
  const files: PackageFile[] = [];
  for (const entry of entries) {
    const path = entry.path === manifest ? 'SKILL.md' : entry.path;
    assertPackagePath(path);
    const key = path.toLowerCase();
    if (kinds.has(key)) throw unsupported();
    const parts = path.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      const folded = prefix.toLowerCase();
      const known = paths.get(folded);
      if (known && known !== prefix) throw unsupported();
      if (depth < parts.length && kinds.get(folded) === false) throw unsupported();
      paths.set(folded, prefix);
    }
    const directory = entry.type === 'tree' && entry.mode === '040000';
    kinds.set(key, directory);
    if (directory) continue;
    if (
      entry.type !== 'blob' ||
      !['100644', '100755'].includes(entry.mode) ||
      entry.size === undefined ||
      (isSkill(path) && path.toLowerCase() === 'skill.md' && entry.path !== manifest)
    )
      throw unsupported();
    expanded += entry.size;
    if (
      entry.size > (path === 'SKILL.md' ? limits.markdown : limits.file) ||
      expanded > limits.expanded
    )
      throw tooLarge();
    files.push({ path, sha: entry.sha, size: entry.size, executable: entry.mode === '100755' });
  }
  for (const path of paths.values()) {
    const parent = directoryOf(path).toLowerCase();
    if (parent && kinds.get(parent) === false) throw unsupported();
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function parallel<T, U>(values: T[], worker: (value: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(values.length, 6) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await worker(values[index]!);
      }
    }),
  );
  return results;
}

type GithubOptions = {
  includePackage?: boolean;
  github?: GithubSkillVersion;
  packageDigest?: string;
  signal?: AbortSignal;
};

export async function previewGithubSkill(
  source: string,
  request: typeof fetch,
  options: GithubOptions,
): Promise<PublicEntryWithPackage[]> {
  const parsed = sourceLocation(source);
  const { owner, repo } = parsed;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const raw = `https://raw.githubusercontent.com/${owner}/${repo}`;
  const controller = new AbortController();
  const operation = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(60_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const transport = (url: string) =>
    request(url, {
      redirect: 'error',
      headers: { 'User-Agent': 'atelier-extension-import' },
      signal: AbortSignal.any([operation, AbortSignal.timeout(12_000)]),
    });
  async function read(url: string, limit: number): Promise<Buffer>;
  async function read(url: string, limit: number, refLookup: true): Promise<Buffer | undefined>;
  async function read(url: string, limit: number, refLookup = false): Promise<Buffer | undefined> {
    const response = await transport(url);
    if (refLookup && [404, 422].includes(response.status)) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' ||
            response.headers.has('retry-after')))
      )
        throw new AppError(
          'GITHUB_SKILL_RATE_LIMIT',
          'GitHub 请求暂时达到限制，请稍后重试。',
          429,
          true,
        );
      throw new AppError(
        'PUBLIC_SOURCE_HTTP',
        `公开来源返回 HTTP ${response.status}。`,
        response.status === 404 ? 404 : 502,
      );
    }
    return bytesOf(response, limit);
  }
  async function tree(sha: string, recursive: boolean) {
    const data = gitTree.parse(
      JSON.parse(
        (
          await read(`${api}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, 12 * 1024 * 1024)
        ).toString('utf8'),
      ),
    );
    if (data.sha !== sha) throw changed();
    if (data.truncated) throw truncated();
    return data.tree;
  }
  async function locate(ref: string, path: string, pinned?: string): Promise<Located | undefined> {
    const result = await read(
      `${api}/commits/${encodeURIComponent(pinned ?? ref)}`,
      2 * 1024 * 1024,
      true,
    );
    if (!result) return;
    const commit = gitCommit.parse(JSON.parse(result.toString('utf8')));
    if (pinned && commit.sha !== pinned) throw changed();
    let sha = commit.commit.tree.sha;
    const folder = parsed.file ? directoryOf(path) : path;
    for (const part of folder ? folder.split('/') : []) {
      const child = (await tree(sha, false)).find((entry) => entry.path === part);
      if (!child || child.type !== 'tree' || child.mode !== '040000') return;
      sha = child.sha;
    }
    return { ref, path, commit: commit.sha, tree: sha };
  }
  async function fetchBlob(
    version: GithubSkillVersion,
    filename: string,
    file: { sha: string; size?: number },
    limit: number,
  ) {
    if (file.size !== undefined && file.size > limit) throw tooLarge();
    const bytes = await read(`${raw}/${version.commit}/${urlPath(filename)}`, limit);
    const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (actual !== file.sha || (file.size !== undefined && file.size !== bytes.length))
      throw changed();
    return bytes;
  }
  async function entry(
    version: GithubSkillVersion,
    path: string,
    manifest: TreeEntry,
    files?: PackageFile[],
  ): Promise<PublicEntryWithPackage> {
    const location = `${raw}/${encodeURIComponent(version.ref)}/${urlPath(path)}`;
    if (location.length > 4096) throw invalid();
    const digest = files && fingerprint(JSON.stringify(files));
    if (options.packageDigest && digest !== options.packageDigest) throw changed();
    const bytes = await fetchBlob(version, path, manifest, limits.markdown);
    let body: string;
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new AppError('GITHUB_SKILL_INVALID_MANIFEST', 'SKILL.md 必须使用 UTF-8 编码。', 422);
    }
    const metadata =
      files && digest
        ? inspectMarkdown(body, {
            digest,
            files: files.map(({ path }) => ({ path, data: '' })),
          })
        : inspectMarkdown(body, undefined, true);
    const name =
      (metadata.name || posix.basename(version.path) || repo)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[^a-z0-9]+/, '')
        .slice(0, 64) || 'extension';
    const base = {
      kind: 'skill' as const,
      name,
      location,
      key: path,
      github: version,
      description: metadata.description || path,
    };
    if (!files || !digest) return base;
    const result: PublicEntryWithPackage = {
      ...base,
      description: metadata.description,
      body,
      revision: fingerprint(body),
      sha256: hash('sha256', bytes),
      upstreamName: metadata.name,
      compatibility: metadata.compatibility,
      packageManifest: {
        digest,
        files: files.map((file) => file.path),
        executables: files.filter((file) => file.executable).map((file) => file.path),
      },
    };
    if (options.includePackage) {
      result.package = {
        digest,
        files: await parallel(files, async (file) => ({
          path: file.path,
          data: (file.path === 'SKILL.md'
            ? bytes
            : await fetchBlob(
                version,
                version.path ? `${version.path}/${file.path}` : file.path,
                file,
                limits.file,
              )
          ).toString('base64'),
          ...(file.executable ? { executable: true } : {}),
        })),
      };
    }
    return result;
  }
  try {
    let version: Located | undefined;
    const possible = candidates(parsed);
    if (options.github) {
      const pin = options.github;
      const candidate = possible.find(
        ({ ref, path }) => ref === pin.ref && parsed.file && directoryOf(path) === pin.path,
      );
      if (!candidate) throw changed();
      version = await locate(candidate.ref, candidate.path, pin.commit);
    } else {
      for (const { ref, path } of possible) {
        version = await locate(ref, path);
        if (version) break;
      }
    }
    if (!version) throw missing();
    const { ref, commit, path, tree: sha } = version;
    const directory = parsed.file ? directoryOf(path) : path;
    const entries = await tree(sha, true);
    const manifest = parsed.file
      ? entries.find((item) => item.path === posix.basename(path))
      : entries.find((item) => !item.path.includes('/') && isSkill(item.path));
    const matching = entries.filter(
      (item) =>
        item.type === 'blob' && ['100644', '100755'].includes(item.mode) && isSkill(item.path),
    );
    if (manifest && (parsed.file || directory || matching.length <= 1)) {
      if (manifest.type !== 'blob' || !['100644', '100755'].includes(manifest.mode))
        throw unsupported();
      const filename = directory ? `${directory}/${manifest.path}` : manifest.path;
      return [
        await entry(
          { ref, commit, path: directory },
          filename,
          manifest,
          packageFiles(entries, manifest.path),
        ),
      ];
    }
    if (parsed.file) throw missing();
    if (matching.length > 100) throw truncated();
    const discovered = await parallel<TreeEntry, PublicEntryWithPackage>(matching, async (item) => {
      const filename = directory ? `${directory}/${item.path}` : item.path;
      const version = { ref, commit, path: directoryOf(filename) };
      try {
        return await entry(version, filename, item);
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          !['PUBLIC_SOURCE_TOO_LARGE', 'GITHUB_SKILL_INVALID_MANIFEST'].includes(error.code)
        )
          throw error;
        return {
          kind: 'skill',
          github: version,
          location: `${raw}/${encodeURIComponent(ref)}/${urlPath(filename)}`,
          key: filename,
          name: posix.basename(version.path) || repo,
          description: '',
          issue:
            error.code === 'PUBLIC_SOURCE_TOO_LARGE' ? 'SKILL.md 超过读取上限。' : error.message,
        };
      }
    });
    const claude = (item: PublicEntry) => /(?:^|\/)\.claude\/skills\//i.test(item.key);
    discovered.sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        Number(claude(b)) - Number(claude(a)) ||
        a.key.localeCompare(b.key),
    );
    const seen = new Set<string>();
    for (const item of discovered) {
      if (
        claude(item) &&
        !seen.has(item.name) &&
        discovered.some((other) => other !== item && other.name === item.name)
      )
        item.recommended = true;
      seen.add(item.name);
    }
    return discovered;
  } finally {
    controller.abort();
  }
}

export type PublicEntryWithPackage = PublicEntry & { package?: SkillPackage };
