import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, posix } from 'node:path';
import { parseDocument } from 'yaml';
import { AppError, type McpTransport } from '../shared/types.js';
import { fingerprint } from './files.js';

const registry = 'https://registry.modelcontextprotocol.io/v0.1/servers';
export type PublicKind = 'skill' | 'command' | 'mcp';
export interface PublicEntry {
  location: string;
  key: string;
  name: string;
  description: string;
  kind: PublicKind;
  revision?: string;
  body?: string;
  transport?: McpTransport;
  issue?: string;
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64) || 'extension';
const pathUrl = (value: string) => value.split('/').map(encodeURIComponent).join('/');
const envName = /^[A-Z_][A-Z0-9_]{0,127}$/;

async function download(url: string, request: typeof fetch, limit: number) {
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(12_000), headers: { 'User-Agent': 'atelier-extension-import' } });
  if (!response.ok) throw new AppError('PUBLIC_SOURCE_HTTP', `公开来源返回 HTTP ${response.status}。`, response.status === 404 ? 404 : 502);
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('PUBLIC_SOURCE_EMPTY', '公开来源没有返回内容。', 502);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let result = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new AppError('PUBLIC_SOURCE_TOO_LARGE', '公开文件超过读取上限，请缩小范围或指定单个文件。', 413);
      }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { reader.releaseLock(); }
}

async function executable(command: string) {
  if (isAbsolute(command)) return command;
  if (!/^[a-zA-Z0-9_.-]+$/.test(command)) return '';
  for (const entry of (process.env.PATH || '').split(delimiter).filter(isAbsolute)) {
    const candidate = join(entry, command);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next directory. */ }
  }
  return '';
}

function httpTransport(url: string, headers: unknown): McpTransport | undefined {
  try {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || /[{}]/.test(url)) return;
  } catch { return; }
  const entries = Object.entries(object(headers));
  if (!entries.length) return { type: 'http', url };
  const [name, value] = entries[0]!;
  const variable = text(value).match(/^Bearer \$\{([A-Z_][A-Z0-9_]*)\}$/i)?.[1];
  if (entries.length === 1 && name.toLowerCase() === 'authorization' && variable && envName.test(variable)) return { type: 'http', url, tokenEnv: variable };
}

async function repositoryTransport(config: Record<string, unknown>): Promise<McpTransport | undefined> {
  if (text(config.url)) return config.type === 'sse' ? undefined : httpTransport(text(config.url), config.headers);
  const args = array(config.args);
  if (!text(config.command) || args.some(value => typeof value !== 'string' || /\$\{|\{[A-Za-z_]/.test(value))) return;
  const env = Object.entries(object(config.env));
  if (env.some(([key, value]) => !envName.test(key) || value !== '${' + key + '}')) return;
  const command = await executable(text(config.command));
  if (command) return { type: 'stdio', command, args: args as string[], envNames: env.map(([key]) => key) };
}

async function registryTransport(server: Record<string, unknown>): Promise<McpTransport | undefined> {
  for (const value of array(server.remotes)) {
    const remote = object(value);
    if (remote.type !== 'streamable-http') continue;
    const headers = array(remote.headers);
    const url = text(remote.url);
    if (!headers.length) {
      const transport = httpTransport(url, {});
      if (transport) return transport;
    }
    if (headers.length === 1) {
      const header = object(headers[0]);
      const token = text(header.value).match(/^Bearer \{([a-zA-Z_][a-zA-Z0-9_]*)\}$/i)?.[1];
      if (token) {
        const transport = httpTransport(url, { [text(header.name)]: 'Bearer ${' + token.toUpperCase() + '}' });
        if (transport) return transport;
      }
    }
  }
  for (const value of array(server.packages)) {
    const pkg = object(value);
    const name = text(pkg.identifier);
    const version = text(pkg.version);
    if (pkg.registryType !== 'npm' || object(pkg.transport).type !== 'stdio' || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version)) continue;
    if (pkg.registryBaseUrl && !['https://registry.npmjs.org', 'https://registry.npmjs.org/'].includes(text(pkg.registryBaseUrl))) continue;
    if (array(pkg.runtimeArguments).length || array(pkg.packageArguments).length) continue;
    const env = array(pkg.environmentVariables).map(object);
    if (env.some(field => !envName.test(text(field.name)) || field.value || field.default)) continue;
    const command = await executable('npx');
    if (command) return { type: 'stdio', command, args: ['--yes', `${name}@${version}`], envNames: env.filter(field => field.isRequired !== false).map(field => text(field.name)) };
  }
}

function githubLocation(source: string) {
  const invalid = () => new AppError('PUBLIC_SOURCE_INVALID', '请输入 GitHub 仓库或文件的 HTTPS 链接。');
  let url: URL;
  try { url = new URL(source); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['github.com', 'raw.githubusercontent.com'].includes(url.hostname)) throw invalid();
  let segments: string[];
  try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw invalid(); }
  const [owner, rawRepo, offset, ...tail] = segments;
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo || !/^[a-zA-Z0-9-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) throw invalid();
  const raw = url.hostname === 'raw.githubusercontent.com';
  if (!raw && offset && !['blob', 'tree'].includes(offset)) throw invalid();
  const ref = (raw ? offset : tail[0]) || 'HEAD';
  const fragments = raw ? tail : tail.slice(1);
  if (ref.split('/').some(part => !part || part === '.' || part === '..') || fragments.some(part => part === '..' || part === '.' || /[\\/\u0000-\u001f]/.test(part))) throw invalid();
  const path = fragments.join('/');
  if ((raw || offset === 'blob') && !path) throw invalid();
  return { owner, repo, ref, path, file: raw || offset === 'blob' };
}

function fileEntry(path: string, kind: PublicKind) {
  if (kind === 'skill') return posix.basename(path).toLowerCase() === 'skill.md';
  if (kind === 'command') return path.endsWith('.md') && /(?:^|\/)commands\//.test(path);
  return ['.mcp.json', 'mcp.json', 'server.json'].includes(posix.basename(path));
}

export async function previewPublic(source: string, kind: PublicKind, request = fetch): Promise<PublicEntry[]> {
  const invalidConfig = '此声明需要当前尚未支持的启动参数、传输方式或凭据格式。';
  try {
    if (source.startsWith('registry:') && kind === 'mcp') {
      const query = source.slice(9).trim();
      if (!query) throw new AppError('PUBLIC_SOURCE_INVALID', '请输入 MCP Registry 搜索词。');
      const exact = query.startsWith('=');
      const name = exact ? query.slice(1) : query;
      const url = exact ? `${registry}/${encodeURIComponent(name)}/versions/latest` : `${registry}?search=${encodeURIComponent(name)}&version=latest&limit=20`;
      const result = object(JSON.parse(await download(url, request, 1024 * 1024)));
      return Promise.all((exact ? [result] : array(result.servers)).map(object).map(async datum => {
        const server = object(datum.server);
        const id = text(server.name);
        const transport = await registryTransport(server);
        return { location: `registry:=${id}`, key: id, name: slug(id.split('/').at(-1) || id), description: text(server.description).slice(0, 500), kind, revision: fingerprint(JSON.stringify(server)), transport, issue: transport ? undefined : invalidConfig };
      }));
    }
    const { owner, repo, ref, path, file } = githubLocation(source);
    const raw = (entry: string) => `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${pathUrl(entry)}`;
    if (!file) {
      const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
      const result = object(JSON.parse(await download(url, request, 12 * 1024 * 1024)));
      return array(result.tree).map(object).filter(entry => entry.type === 'blob' && entry.mode === '100644')
        .map(entry => text(entry.path)).filter(entry => (!path || entry.startsWith(path + '/')) && fileEntry(entry, kind))
        .slice(0, 100).map(entry => ({ location: raw(entry), key: entry, name: kind === 'skill' ? posix.basename(posix.dirname(entry)) : posix.basename(entry), description: entry, kind }));
    }
    if ((kind === 'skill' && !fileEntry(path, kind)) || (kind === 'command' && !path.endsWith('.md')) || (kind === 'mcp' && !path.endsWith('.json'))) throw new AppError('PUBLIC_SOURCE_INVALID', '链接的文件类型与当前扩展类型不匹配。');
    const location = raw(path);
    const body = await download(location, request, kind === 'mcp' ? 128 * 1024 : 65000);
    const revision = fingerprint(body);
    if (kind !== 'mcp') {
      const header = body.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
      const parsed = header ? object(parseDocument(header[1]!).toJS({ maxAliasCount: 0 })) : {};
      const fallback = kind === 'skill' ? posix.basename(posix.dirname(path)) : posix.basename(path, '.md');
      return [{ location, key: path, name: slug(text(parsed.name) || fallback), description: text(parsed.description).slice(0, 500), kind, revision, body }];
    }
    const manifest = object(JSON.parse(body));
    if (typeof manifest.name === 'string' && (manifest.remotes || manifest.packages)) {
      const id = manifest.name;
      const transport = await registryTransport(manifest);
      return [{ location, key: id, name: slug(id.split('/').at(-1) || id), description: text(manifest.description).slice(0, 500), kind, revision, transport, issue: transport ? undefined : invalidConfig }];
    }
    return Promise.all(Object.entries(object(manifest.mcpServers)).slice(0, 40).map(async ([key, value]) => {
      const config = object(value);
      const transport = await repositoryTransport(config);
      return { location, key, name: slug(key), description: text(config.description).slice(0, 500), kind, revision, transport, issue: transport ? undefined : invalidConfig };
    }));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('PUBLIC_SOURCE_FAILED', '读取公开来源失败，请检查网络、链接与文件格式。', 502);
  }
}
