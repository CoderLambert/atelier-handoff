import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { AppError, type Extension, type ExtensionSelection, type Mode, type UsedExtension } from '../shared/types.js';
import { Store } from './store.js';
import type { PublicEntry } from './public-extensions.js';

type McpExtension = Extract<Extension, { kind: 'mcp' }>;
const name = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/);
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const version = z.number().int().positive();
export const extensionSelections = z.array(z.object({ id: z.string().uuid(), version, tools: z.array(toolName).max(40).optional() })).max(12);
const shared = { name, description: z.string().trim().max(500).default(''), enabled: z.boolean().default(false) };
const http = z.object({ type: z.literal('http'), url: z.string().url().max(2048), tokenEnv: envName.optional() }).superRefine(({url}, ctx) => {
  const endpoint = new URL(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: '请输入 HTTPS 或本机 HTTP 地址，凭据使用环境变量。' });
  }
});
const stdio = z.object({ type: z.literal('stdio'), command: z.string().max(4096).refine(path => isAbsolute(path) && !path.includes('\0'), '请输入可执行文件的绝对路径。'), args: z.array(z.string().max(2048)).max(40), envNames: z.array(envName).max(20) });
const extensionInput = z.union([
  z.object({ ...shared, kind: z.enum(['command', 'skill']), source: z.string().max(200).default('本机'), body: z.string().min(1).max(65000) }),
  z.object({ ...shared, kind: z.literal('mcp'), transport: z.union([http, stdio]), allowedTools: z.array(z.object({ name: toolName, access: z.enum(['read', 'approval']) })).max(40).default([]) }),
]);

export function inspectMarkdown(body: string) {
  const normalized = body.replace(/^﻿/, '').replaceAll('\r\n', '\n');
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  let metadata: Record<string, unknown> = {};
  let compatibility: string | undefined;
  if (frontmatter) {
    try {
      const document = parseDocument(frontmatter[1]!, { uniqueKeys: true });
      if (document.errors.length) throw document.errors[0];
      const parsed: unknown = document.toJS({ maxAliasCount: 0 });
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      metadata = parsed as Record<string, unknown>;
    } catch { compatibility = 'Markdown frontmatter 格式无效。'; }
  } else if (normalized.startsWith('---\n')) compatibility = 'Markdown frontmatter 缺少结束标记。';
  const text = (frontmatter ? normalized.slice(frontmatter[0].length) : normalized).trim();
  if (!text) compatibility ??= '请填写扩展说明正文。';
  if (['hooks', 'mcpServers', 'context', 'agent'].some(key => Object.hasOwn(metadata, key)) || /(?:^|\s)!`|\$\{CLAUDE_SKILL_DIR\}|\]\((?:\.\/|\.\.\/|(?:scripts|references|assets)\/)/m.test(text) || metadata['allowed-tools'] !== undefined) {
    compatibility ??= '此扩展依赖 Claude Code 的动态命令、脚本、附属文件或专用工具配置。当前支持独立 Markdown 说明。';
  }
  return { text, supported: !compatibility, compatibility, userInvocable: metadata['user-invocable'] !== false, description: typeof metadata.description === 'string' ? metadata.description.slice(0, 500) : '' };
}

export class ProjectExtensions {
  constructor(private store: Store) {}

  list(projectId: string): Extension[] {
    this.store.get('projects', projectId);
    return this.store.list('extensions').filter(item => item.projectId === projectId).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(projectId: string, id: string): Extension {
    const record = this.store.get('extensions', id);
    if (record.projectId !== projectId) throw new AppError('NOT_FOUND', '项目扩展不存在。', 404);
    return record;
  }

  save(projectId: string, raw: unknown, id?: string, marketId?: string): Extension {
    const catalog = this.list(projectId);
    const previous = id ? this.get(projectId, id) : undefined;
    if (previous) {
      const update = z.object({ version }).passthrough().parse(raw);
      if (update.version !== previous.version) throw new AppError('EXTENSION_CHANGED', '配置已更新，请刷新后重新编辑。', 409);
    }
    const supplied = z.record(z.string(), z.unknown()).parse(raw);
    const input = extensionInput.parse({ ...previous, ...supplied });
    if (previous && previous.kind !== input.kind) throw new AppError('EXTENSION_KIND', '扩展类型无法修改。');
    if (catalog.some(item => item.id !== id && item.name === input.name && (item.kind === 'mcp') === (input.kind === 'mcp'))) {
      throw new AppError('EXTENSION_NAME_TAKEN', '当前项目已有同名扩展。', 409);
    }
    const base = { id: id ?? randomUUID(), projectId, version: (previous?.version ?? 0) + 1, name: input.name, description: input.description, enabled: input.enabled, origin: previous?.origin, marketId: previous?.marketId ?? marketId };
    let record: Extension;
    if (input.kind === 'mcp') {
      const sameTransport = previous?.kind === 'mcp' && JSON.stringify(previous.transport) === JSON.stringify(input.transport);
      const tools = sameTransport ? previous.tools : [];
      const allowedTools = [...new Map(input.allowedTools.map(entry => [entry.name, entry])).values()].filter(entry => tools.some(tool => tool.name === entry.name));
      record = { ...base, kind: 'mcp', transport: input.transport, source: input.transport.type === 'stdio' ? '本机进程' : 'HTTP', tools, allowedTools, status: sameTransport ? previous.status : undefined, statusMessage: sameTransport ? previous.statusMessage : undefined };
    } else {
      const meta = inspectMarkdown(input.body);
      record = { ...base, kind: input.kind, body: input.body, source: input.source, supported: meta.supported, compatibility: meta.compatibility, userInvocable: meta.userInvocable, enabled: meta.supported && base.enabled, description: base.description || meta.description };
    }
    return this.store.put('extensions', record);
  }

  savePublic(projectId: string, entry: PublicEntry, update?: { id: string; version: number }) {
    if (!entry.revision || entry.issue) throw new AppError('PUBLIC_SOURCE_UNSUPPORTED', entry.issue || '请先选择并预览要导入的条目。');
    return this.store.transaction(() => {
      const previous = update ? this.get(projectId, update.id) : undefined;
      if (update && (!previous?.origin || previous.origin.location !== entry.location || previous.origin.key !== entry.key || previous.version !== update.version || previous.kind !== entry.kind)) {
        throw new AppError('EXTENSION_CHANGED', '扩展来源或版本已变化，请刷新后重新同步。', 409);
      }
      if (previous && previous.origin?.revision === entry.revision) return { item: previous, changed: false };
      if (!previous && this.list(projectId).some(item => item.origin?.location === entry.location && item.origin.key === entry.key)) {
        throw new AppError('PUBLIC_SOURCE_EXISTS', '当前项目已导入此条目，请从对应卡片同步。', 409);
      }
      const fields = { name: previous?.name ?? entry.name, description: entry.description, ...(previous ? { version: previous.version } : {}) };
      const payload = entry.kind === 'mcp' ? {
        ...fields, kind: entry.kind, transport: entry.transport,
        enabled: previous?.kind === 'mcp' && previous.enabled && JSON.stringify(previous.transport) === JSON.stringify(entry.transport),
      } : { ...fields, kind: entry.kind, body: entry.body, enabled: previous?.enabled ?? true };
      const item = this.save(projectId, payload, previous?.id);
      return { item: this.store.put('extensions', {
        ...item, source: entry.location, origin: { location: entry.location, key: entry.key, revision: entry.revision! },
      }), changed: true };
    });
  }

  remove(projectId: string, id: string) {
    this.get(projectId, id);
    this.store.delete('extensions', id);
  }

  recordTest(extension: McpExtension, result: Pick<McpExtension, 'tools' | 'status' | 'statusMessage'>): Extension {
    const current = this.get(extension.projectId, extension.id);
    if (current.kind !== 'mcp' || current.version !== extension.version) throw new AppError('EXTENSION_CHANGED', '配置在测试期间已更新，请重新测试。', 409);
    const tools = result.status === 'connected' ? result.tools : current.tools;
    const changed = JSON.stringify(tools) !== JSON.stringify(current.tools);
    return this.store.put('extensions', { ...current, ...result, tools, version: changed ? current.version + 1 : current.version, allowedTools: current.allowedTools.filter(entry => tools.some(tool => tool.name === entry.name)) });
  }

  resolve(projectId: string, mode: Mode, text: string, selections: ExtensionSelection[]): ExtensionBundle {
    const catalog = this.list(projectId);
    const supplied = new Map(selections.map(selection => [selection.id, selection]));
    const slash = /^\/([a-z0-9][a-z0-9_-]{0,63})(?:\s+|$)/.exec(text);
    let args = text;
    if (slash) {
      const item = catalog.find(entry => entry.kind !== 'mcp' && entry.name === slash[1]);
      if (!item) throw new AppError('EXTENSION_UNKNOWN', `找不到 /${slash[1]}，可在扩展页导入或从输入框选择。`);
      if (!supplied.has(item.id)) supplied.set(item.id, { id: item.id, version: item.version });
      args = text.slice(slash[0].length).trim();
    }
    const instructions: string[] = [];
    const used: UsedExtension[] = [];
    const mcp: McpExtension[] = [];
    for (const selection of supplied.values()) {
      const item = catalog.find(entry => entry.id === selection.id);
      if (!item || !item.enabled || item.version !== selection.version) throw new AppError('EXTENSION_CHANGED', '所选扩展已禁用、移动或更新，请移除旧选择后重新选取。', 409);
      const reference = { id: item.id, kind: item.kind, name: item.name, version: item.version };
      if (item.kind !== 'mcp') {
        if (!item.supported || !item.userInvocable) throw new AppError('EXTENSION_UNAVAILABLE', `/${item.name} 当前无法手动调用。`, 409);
        const template = inspectMarkdown(item.body).text;
        const rendered = template.replaceAll('$ARGUMENTS', () => args);
        instructions.push(`扩展 ${item.name}（${item.kind}）说明：\n${rendered}`);
        used.push(reference);
        continue;
      }
      const allowed = item.allowedTools.filter(tool => (selection.tools === undefined || selection.tools.includes(tool.name)) && (mode === 'edit' || tool.access === 'read'));
      if (!allowed.length || selection.tools?.some(name => !allowed.some(tool => tool.name === name))) {
        throw new AppError('MCP_TOOL_NOT_ALLOWED', '所选 MCP 工具未授权或需要切换到受控修改。', 403);
      }
      mcp.push({ ...item, allowedTools: allowed });
      used.push({ ...reference, tools: allowed.map(tool => tool.name) });
    }
    return { prompt: instructions.length ? `${instructions.join('\n\n')}\n\n本轮用户要求：\n${args}` : text, used, mcp };
  }
}

export interface ExtensionBundle { prompt: string; used: UsedExtension[]; mcp: McpExtension[] }
export type EnabledMcp = McpExtension;
