import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { z } from 'zod';
import { AppError } from '../shared/types.js';
import { fingerprint } from './files.js';
import { inspectMarkdown } from './extensions.js';
import type { PublicEntry } from './public-extensions.js';

const origin = 'https://api.skillhub.cn';
const cdnHosts = new Set([
  'skillhub-1388575217.cos.ap-guangzhou.myqcloud.com',
  'skillhub-1388575217.cos.accelerate.myqcloud.com',
]);
const coordinate =
  /^@([a-zA-Z0-9_-]{1,100})\/([a-zA-Z0-9_-]{1,100})(?:@([a-zA-Z0-9][a-zA-Z0-9.+-]{0,79}))?$/;
const versionPattern = /^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,79}$/;
const markdownLimit = 65_000;
const searchResult = z.object({
  namespace: z.object({ canonicalName: z.string().regex(coordinate) }),
  displayName: z.string(),
  category: z
    .string()
    .regex(/^[a-z0-9-]{1,60}$/)
    .nullish()
    .catch(undefined),
  description: z.string().optional(),
  description_zh: z.string().optional(),
  owner_name: z.string().nullish(),
  version: z.string().regex(versionPattern),
});
const resolvedSkill = z.object({
  namespace: z.object({ canonicalName: z.string(), handle: z.string(), publicSlug: z.string() }),
  latestVersion: z.object({ version: z.string().regex(versionPattern) }),
});

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body)
    throw new AppError(
      'SKILLHUB_UNAVAILABLE',
      `SkillHub 返回 HTTP ${response.status}。`,
      response.status === 404 ? 404 : 502,
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new AppError('SKILLHUB_TOO_LARGE', 'SkillHub 响应超过读取上限。', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function doRequest(request: typeof fetch, url: URL, signal: AbortSignal) {
  try {
    return await request(url, { redirect: 'manual', signal });
  } catch {
    throw new AppError('SKILLHUB_UNAVAILABLE', '无法连接 SkillHub，请稍后重试。', 502);
  }
}

async function apiJson(
  path: string,
  params: Record<string, string>,
  request: typeof fetch,
  signal: AbortSignal,
): Promise<unknown> {
  const url = new URL(path, origin);
  url.search = new URLSearchParams(params).toString();
  const raw = await readLimited(await doRequest(request, url, signal), 1024 * 1024);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError('SKILLHUB_INVALID_RESPONSE', 'SkillHub 返回了无法读取的目录数据。', 502);
  }
}

export async function searchSkillHub(query: string, request = fetch) {
  const result = z
    .object({ results: z.array(z.unknown()) })
    .safeParse(
      await apiJson(
        '/api/v1/search',
        { q: query, limit: '48' },
        request,
        AbortSignal.timeout(10_000),
      ),
    );
  if (!result.success)
    throw new AppError('SKILLHUB_INVALID_RESPONSE', 'SkillHub 搜索结果格式发生变化。', 502);
  const seen = new Set<string>();
  return result.data.results.slice(0, 48).flatMap((raw) => {
    const parsed = searchResult.safeParse(raw);
    if (!parsed.success) return [];
    const item = parsed.data;
    const name = item.namespace.canonicalName;
    if (seen.has(name) || coordinate.exec(name)?.[3]) return [];
    seen.add(name);
    return [
      {
        source: `skillhub:${name}@${item.version}`,
        coordinate: name,
        version: item.version,
        title: item.displayName.slice(0, 160),
        description: (item.description_zh || item.description || '').slice(0, 600),
        publisher: item.owner_name?.slice(0, 100),
        category: item.category ?? undefined,
      },
    ];
  });
}

async function downloadPackage(
  namespace: string,
  slug: string,
  version: string,
  request: typeof fetch,
  signal: AbortSignal,
) {
  const url = new URL('/api/v1/download', origin);
  url.search = new URLSearchParams({ namespace, slug, version }).toString();
  let response = await doRequest(request, url, signal);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    await response.body?.cancel();
    const target = location && URL.canParse(location) ? new URL(location) : undefined;
    if (
      !target ||
      target.protocol !== 'https:' ||
      !cdnHosts.has(target.hostname) ||
      target.port ||
      target.username ||
      target.password
    )
      throw new AppError('SKILLHUB_INVALID_RESPONSE', 'SkillHub 下载地址未通过校验。', 502);
    response = await doRequest(request, target, signal);
  }
  return readLimited(response, 8 * 1024 * 1024);
}

async function readSkillDocument(data: Buffer) {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    fromBuffer(data, { lazyEntries: true, strictFileNames: true }, (error, zip) =>
      error ? reject(error) : resolve(zip!),
    ),
  );
  const matches: Entry[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.once('error', reject);
    zip.once('end', resolve);
    zip.on('entry', (entry: Entry) => {
      const symlink = ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
      if (!symlink && /^([^/]+\/)?SKILL\.md$/i.test(entry.fileName)) matches.push(entry);
      zip.readEntry();
    });
    if (zip.entryCount > 1000) reject(new Error('Too many package entries'));
    else zip.readEntry();
  });
  const [entry] = matches;
  if (matches.length !== 1 || !entry || entry.uncompressedSize > markdownLimit)
    throw new AppError(
      'SKILLHUB_PACKAGE_UNSUPPORTED',
      'SkillHub 包需要包含一份可独立读取的 SKILL.md。',
      422,
    );
  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
    zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream!))),
  );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > markdownLimit)
      throw new AppError('SKILLHUB_TOO_LARGE', 'SKILL.md 超过读取上限。', 413);
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export function normalizeSkillHubMarkdown(body: string): string {
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (!header) return body;
  const yaml = header[1]!;
  let document = parseDocument(yaml, { uniqueKeys: true });
  const repairable =
    document.errors.length > 0 &&
    document.errors.every((error) => error.code === 'BLOCK_AS_IMPLICIT_KEY');
  if (repairable) {
    // A plain localized description can contain punctuation YAML reads as a nested mapping.
    const repaired = yaml.replace(
      /^(description(?:_[a-zA-Z-]+)?):[ \t]+([^\r\n]+)$/gm,
      (line, key: string, value: string) =>
        /^[\p{L}\p{N}]/u.test(value) && /:[ \t]/.test(value)
          ? `${key}: ${JSON.stringify(value)}`
          : line,
    );
    if (repaired !== yaml) document = parseDocument(repaired, { uniqueKeys: true });
  }
  if (document.errors.length || !isMap(document.contents)) return body;
  const toolsNode = document.get('allowed-tools');
  const declaredTools = isSeq(toolsNode)
    ? toolsNode.items.map((item) => (isScalar(item) ? item.value : undefined))
    : null;
  const advisoryTools =
    Array.isArray(declaredTools) &&
    declaredTools.every(
      (tool) => typeof tool === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool),
    );
  if (advisoryTools) {
    // Atelier provides its own per-run tool scope and approvals.
    document.delete('allowed-tools');
  }
  if (!repairable && !advisoryTools) return body;
  return `---\n${document.toString()}---\n${body.slice(header[0].length)}`;
}

export async function previewSkillHub(source: string, request = fetch): Promise<PublicEntry> {
  const match = coordinate.exec(source.slice('skillhub:'.length));
  if (!match) throw new AppError('PUBLIC_SOURCE_INVALID', '请输入有效的 SkillHub 技能坐标。');
  const [, namespace, slug, version] = match;
  const name = `@${namespace}/${slug}`;
  const signal = AbortSignal.timeout(15_000);
  const resolved = resolvedSkill.safeParse(
    await apiJson('/api/v1/skills/resolve', { coordinate: name }, request, signal),
  );
  if (
    !resolved.success ||
    resolved.data.namespace.canonicalName !== name ||
    resolved.data.namespace.handle !== namespace ||
    resolved.data.namespace.publicSlug !== slug
  )
    throw new AppError('SKILLHUB_INVALID_RESPONSE', 'SkillHub 包来源未通过校验。', 502);
  const selectedVersion = version ?? resolved.data.latestVersion.version;
  try {
    const archive = await downloadPackage(namespace!, slug!, selectedVersion, request, signal);
    const body = normalizeSkillHubMarkdown(await readSkillDocument(archive));
    const metadata = inspectMarkdown(body);
    return {
      kind: 'skill',
      location: `skillhub:${name}`,
      key: name,
      name:
        slug!
          .toLowerCase()
          .replace(/^[^a-z0-9]+/, '')
          .slice(0, 64) || 'extension',
      description: metadata.description,
      revision: fingerprint(body),
      body,
      upstreamVersion: selectedVersion,
      issue: metadata.compatibility,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SKILLHUB_PACKAGE_UNSUPPORTED', '无法读取 SkillHub 包中的 SKILL.md。', 422);
  }
}
