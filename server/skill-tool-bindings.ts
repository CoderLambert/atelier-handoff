import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { AppError, type SkillToolBinding } from '../shared/types.js';
import type { Store } from './store.js';

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const binding = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('builtin'),
    name: identifier,
    tool: z.enum(['list_files', 'search_files', 'publish_artifact']),
  }),
  z.object({
    kind: z.literal('mcp'),
    name: identifier,
    extensionId: z.string().uuid(),
    tool: z.string().min(1).max(128),
  }),
  z.object({
    kind: z.literal('http'),
    name: identifier,
    url: z.string().max(1000),
    parameter: identifier,
    description: z.string().trim().min(1).max(300),
  }),
  z.object({ kind: z.literal('command'), name: identifier, preset: z.literal('pdftotext') }),
]);
const config = z.object({ bindings: z.array(binding).max(10) });
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(address, prefix);

export function httpBindingUrl(
  binding: Extract<SkillToolBinding, { kind: 'http' }>,
  value: string,
): URL {
  let url: URL;
  const placeholder = `{${binding.parameter}}`;
  try {
    url = new URL(binding.url);
  } catch {
    throw new AppError('INVALID_INPUT', '请输入有效的 HTTPS 接口地址。');
  }
  const host = url.hostname;
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    isIP(host) ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host) ||
    /\.(?:localhost|local|internal|test|invalid|example|onion)$/i.test(host)
  )
    throw new AppError('INVALID_INPUT', 'HTTP 模板仅支持公网 HTTPS 域名和默认端口。');
  const parts = url.pathname.split('/');
  const index = parts.findIndex(
    (part) => part === placeholder || part === encodeURIComponent(placeholder),
  );
  if (index < 0) {
    if (/[{}]|%7[BD]/i.test(url.pathname + url.search))
      throw new AppError('INVALID_INPUT', '路径占位符必须独占一段路径。');
    url.searchParams.set(binding.parameter, value);
  } else {
    if (
      parts.filter((part) => /[{}]|%7[BD]/i.test(part)).length !== 1 ||
      /[{}]|%7[BD]/i.test(url.search) ||
      !value ||
      /[/%\\]/.test(value) ||
      value === '.' ||
      value === '..'
    )
      throw new AppError('INVALID_INPUT', '路径参数无效。');
    parts[index] = encodeURIComponent(value);
    url.pathname = parts.join('/');
  }
  return url;
}

const key = (projectId: string, skillId: string) => `skill-tool-bindings:${projectId}:${skillId}`;
export function hasSkillToolBindingConfig(store: Store, projectId: string, skillId: string) {
  return Boolean(
    store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(key(projectId, skillId)),
  );
}
export function readSkillToolBindings(
  store: Store,
  projectId: string,
  skillId: string,
): SkillToolBinding[] {
  const row = store.db
    .prepare('SELECT value FROM settings WHERE key=?')
    .get(key(projectId, skillId));
  return row ? config.parse(JSON.parse(String(row.value))).bindings : [];
}

export function saveSkillToolBindings(
  store: Store,
  projectId: string,
  skillId: string,
  input: unknown,
) {
  const skill = store.get('extensions', skillId);
  if (skill.kind !== 'skill' || skill.projectId !== projectId)
    throw new AppError('NOT_FOUND', 'Skill 不存在。', 404);
  const { bindings } = config.parse(input);
  if (new Set(bindings.map(({ name }) => name)).size !== bindings.length)
    throw new AppError('INVALID_INPUT', '同一个 Skill 的绑定名称不能重复。');
  for (const item of bindings) {
    if (item.kind === 'http') httpBindingUrl(item, 'example');
    if (item.kind === 'mcp') {
      const service = store.get('extensions', item.extensionId);
      if (
        service.projectId !== projectId ||
        service.kind !== 'mcp' ||
        !service.enabled ||
        !service.allowedTools.some(({ name }) => name === item.tool) ||
        !service.tools.some(({ name }) => name === item.tool)
      )
        throw new AppError('MCP_TOOL_NOT_ALLOWED', '请先在当前项目授权对应的 MCP 工具。', 403);
    }
  }
  store.db
    .prepare(
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(key(projectId, skillId), JSON.stringify({ bindings }));
  return bindings;
}

export async function executeHttpBinding(
  binding: Extract<SkillToolBinding, { kind: 'http' }>,
  value: string,
  signal: AbortSignal,
  verify?: () => void,
) {
  const url = httpBindingUrl(binding, value);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  try {
    const addresses = await new Resolver({ timeout: 2000, tries: 1 }).resolve4(url.hostname);
    deadline.throwIfAborted();
    if (!addresses.length || addresses.some((address) => blocked.check(address)))
      throw new Error('Private host');
    verify?.();
    const address = addresses[0]!;
    return await new Promise<{ source: string; text: string; truncated: boolean }>(
      (resolve, reject) => {
        const req = request(
          url,
          {
            method: 'GET',
            signal: deadline,
            agent: false,
            family: 4,
            lookup: (_host, _options, callback) => callback(null, address, 4),
            headers: { Accept: 'application/json, text/plain' },
          },
          (res) => {
            if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
              res.destroy();
              reject(new Error('HTTP request failed'));
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on('error', reject);
            res.on('data', (chunk: Buffer) => {
              const limit = 48 * 1024;
              const remaining = limit - bytes;
              if (chunk.length > remaining) {
                if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
                resolve({
                  source: url.hostname,
                  text: Buffer.concat(chunks).toString('utf8'),
                  truncated: true,
                });
                res.destroy();
                return;
              }
              bytes += chunk.length;
              chunks.push(chunk);
            });
            res.on('end', () =>
              resolve({
                source: url.hostname,
                text: Buffer.concat(chunks).toString('utf8'),
                truncated: false,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      },
    );
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AppError) throw error;
    throw new AppError('SKILL_HTTP_FAILED', 'HTTP 工具无法连接公网服务或未收到有效响应。', 502);
  }
}
