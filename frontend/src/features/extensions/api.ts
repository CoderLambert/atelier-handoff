/**
 * @file 提供扩展目录和技能工具绑定的数据访问接口。
 * @implementation 定义查询键、响应和错误辅助方法，通过 React Query 查询、修改数据并刷新相关缓存。
 * @updated 2026-11-23T04:58:09+08:00
 */
import { getTranslator, translateError } from '@/i18n';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Extension, ExtensionSelection, McpTransport, SkillToolBinding } from '@shared/types';
import { api, ApiError } from '@/api/client';

export type ExtensionKind = Extension['kind'];
export type McpExtension = Extract<Extension, { kind: 'mcp' }>;
export type MarkdownExtension = Exclude<Extension, McpExtension>;
export type StartSkill = (
  projectId: string,
  selection: ExtensionSelection,
  editable: boolean,
) => Promise<void>;
export interface PublicEntry {
  location: string;
  key: string;
  name: string;
  description: string;
  kind: ExtensionKind;
  revision?: string;
  sha256?: string;
  upstreamName?: string;
  upstreamVersion?: string;
  packageManifest?: { digest: string; files: string[] };
  body?: string;
  transport?: McpTransport;
  issue?: string;
}
export interface TestResult {
  status: 'connected' | 'needs-auth' | 'failed';
  tools: McpExtension['tools'];
  message?: string;
  statusMessage?: string;
  item?: Extension;
}
export type ItemResponse = { item?: Extension; extension?: Extension } | Extension | undefined;

export const kinds: Record<ExtensionKind, string> = {
  get skill() {
    return getTranslator('extensions')('common.skills');
  },
  get command() {
    return getTranslator('extensions')('common.commands');
  },
  get mcp() {
    return getTranslator('extensions')('common.mcp');
  },
};
export const testLabels = {
  get connected() {
    return getTranslator('extensions')('extensions.connected');
  },
  get 'needs-auth'() {
    return getTranslator('extensions')('extensions.needsAuth');
  },
  get failed() {
    return getTranslator('extensions')('extensions.connectionFailed');
  },
};
const localResponseErrors = new Map([
  ['扩展列表响应缺少 items。', 'extensions.missingItems'],
  ['公开来源响应缺少 items。', 'publicImport.missingItems'],
  ['智能体列表响应缺少 items，请重新加载。', 'agents.missingList'],
  ['操作响应缺少智能体信息，请刷新列表确认结果。', 'agents.missingAgent'],
  ['创建会话响应缺少会话信息，请刷新会话列表确认结果。', 'agents.missingSession'],
] as const);

export function messageOf(error: unknown) {
  const t = getTranslator('extensions');
  if (error instanceof ApiError) return translateError(error, t('common.operationFailed'));
  if (error instanceof Error) {
    // These pinned legacy callbacks still throw source messages. Translate them at display time.
    for (const [source, key] of localResponseErrors) {
      if (error.message === source) return t(key);
    }
    return error.message;
  }
  return translateError(error, t('common.operationFailed'));
}
const extensionMessages = new Map([
  ['Markdown frontmatter 格式无效。', 'extensionDetail.invalidFrontmatter'],
  ['Markdown frontmatter 缺少结束标记。', 'extensionDetail.unclosedFrontmatter'],
  ['请填写扩展说明正文。', 'extensionDetail.emptyBody'],
  [
    '此扩展包含动态命令、钩子、专用权限配置或包中不存在的附属文件。',
    'extensionDetail.unsupportedPackage',
  ],
  [
    '此扩展依赖 Claude Code 的动态命令、脚本、附属文件或专用工具配置。当前支持独立 Markdown 说明。',
    'extensionDetail.unsupportedMarkdown',
  ],
  ['MCP 服务要求有效的凭据。', 'extensionDetail.authRequired'],
  ['MCP 连接或调用失败。请检查地址、进程参数和服务端日志。', 'extensionDetail.connectionFailed'],
  ['已打开 8 个常驻 MCP。停用不再使用的服务后重试。', 'extensionDetail.processLimit'],
  ['MCP 会话已关闭，请重新发起工具调用。', 'extensionDetail.sessionClosedRetry'],
  ['MCP 会话已关闭。', 'extensionDetail.sessionClosed'],
  ['请使用桌面内置浏览器工具。', 'extensionDetail.nativeBrowser'],
  ['MCP 工具描述包含配置中的凭据，请修改服务端工具定义。', 'extensionDetail.secretMetadata'],
] as const);

/** Translate known application diagnostics; leave upstream text and identifiers intact. */
export function extensionDetail(message: string | undefined): string {
  if (!message) return '';
  const t = getTranslator('extensions');
  for (const [source, key] of extensionMessages) {
    if (message === source) return t(key);
  }
  const discovered = /^已发现 (\d+) 项工具。$/.exec(message);
  if (discovered) return t('extensionDetail.discovered', { count: Number(discovered[1]) });
  const environment = /^请在本机服务环境中设置 ([A-Za-z_][A-Za-z0-9_]*)。$/.exec(message);
  if (environment?.[1]) return t('extensionDetail.environmentRequired', { name: environment[1] });
  return message;
}

export const isConflict = (error: unknown) =>
  Boolean(error && typeof error === 'object' && 'status' in error && error.status === 409);
export const allowsAuto = (item?: MarkdownExtension) => item?.modelInvocable !== false;
export const autoEnabled = (item?: MarkdownExtension) =>
  allowsAuto(item) && item?.autoInvoke !== false;
export const endpoint = (projectId: string, suffix?: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/extensions${suffix ? `/${suffix}` : ''}`;
export const extensionKeys = {
  all: (projectId: string) => ['extensions', projectId] as const,
  list: (projectId: string) => ['extensions', projectId, 'list'] as const,
  mutations: (projectId: string) => ['extensions', projectId, 'mutation'] as const,
  toolBindings: (projectId: string, skillId: string) =>
    ['extensions', projectId, 'tool-bindings', skillId] as const,
};
export function returnedItem(result: ItemResponse) {
  if (!result) return undefined;
  if ('id' in result) return result;
  return result.item ?? result.extension;
}
export const extensionsQuery = (projectId: string) =>
  queryOptions({
    queryKey: extensionKeys.list(projectId),
    queryFn: async ({ signal }) => {
      const result = await api<{ items: Extension[] }>(endpoint(projectId), { signal });
      if (!Array.isArray(result?.items)) throw new Error('扩展列表响应缺少 items。');
      return result.items;
    },
    staleTime: 30_000,
    enabled: Boolean(projectId),
  });
export function useExtensions(projectId?: string) {
  return useQuery(extensionsQuery(projectId ?? ''));
}
interface ToolBindingsResponse {
  bindings: SkillToolBinding[];
}
function bindingsOf(result: ToolBindingsResponse) {
  const t = getTranslator('extensions');
  if (!Array.isArray(result?.bindings)) throw new Error(t('extensions.missingBindings'));
  return result.bindings;
}
const toolBindingsEndpoint = (projectId: string, skillId: string) =>
  endpoint(projectId, `${encodeURIComponent(skillId)}/tool-bindings`);
export function useSkillToolBindings(projectId: string, skillId: string) {
  return useQuery({
    queryKey: extensionKeys.toolBindings(projectId, skillId),
    queryFn: async ({ signal }) =>
      bindingsOf(
        await api<ToolBindingsResponse>(toolBindingsEndpoint(projectId, skillId), { signal }),
      ),
    enabled: Boolean(projectId && skillId),
  });
}
export function useSaveSkillToolBindings(projectId: string, skillId: string) {
  const client = useQueryClient();
  const queryKey = extensionKeys.toolBindings(projectId, skillId);
  return useMutation({
    mutationKey: extensionKeys.mutations(projectId),
    scope: { id: `extensions:${projectId}` },
    mutationFn: async (bindings: SkillToolBinding[]) =>
      bindingsOf(
        await api<ToolBindingsResponse>(toolBindingsEndpoint(projectId, skillId), {
          method: 'PUT',
          body: { bindings },
        }),
      ),
    onMutate: async () => {
      await client.cancelQueries({ queryKey });
    },
    onSuccess: async (bindings) => {
      client.setQueryData(queryKey, bindings);
      await client.invalidateQueries({ queryKey: extensionKeys.list(projectId) });
    },
  });
}
interface ExtensionOperation {
  suffix?: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  removeId?: string;
}
// Hook-level callbacks finish even when the dialog that started a request unmounts.
// Every operation carries its own project key; late responses cannot update another project.
export function useExtensionMutation<T = ItemResponse>(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: extensionKeys.mutations(projectId),
    scope: { id: `extensions:${projectId}` },
    mutationFn: (operation: ExtensionOperation) =>
      api<T>(endpoint(projectId, operation.suffix), {
        method: operation.method,
        body: operation.body,
      }),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: extensionKeys.list(projectId) });
    },
    onSuccess: (result, operation) => {
      const item = returnedItem(result as ItemResponse);
      if (item)
        client.setQueryData<Extension[]>(extensionKeys.list(projectId), (items) => {
          if (!items) return [item];
          return items.some((old) => old.id === item.id)
            ? items.map((old) => (old.id === item.id ? item : old))
            : [...items, item];
        });
      if (operation.removeId)
        client.setQueryData<Extension[]>(extensionKeys.list(projectId), (items) =>
          items?.filter((old) => old.id !== operation.removeId),
        );
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: extensionKeys.list(projectId) });
    },
  });
}
