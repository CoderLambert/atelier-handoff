import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Extension, McpTransport } from '@shared/types';
import { api } from '@/api/client';

export type ExtensionKind = Extension['kind'];
export type McpExtension = Extract<Extension, { kind: 'mcp' }>;
export type MarkdownExtension = Exclude<Extension, McpExtension>;
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
export type MarketStatus =
  | 'available'
  | 'enabled'
  | 'disabled'
  | 'legacy'
  | 'update-available'
  | 'local-modified'
  | 'conflict';
export interface MarketSkill {
  id: string;
  name: string;
  title: string;
  category: string;
  description: string;
  publisher: string;
  repository: string;
  url: string;
  path: string;
  upstreamName: string;
  commit: string;
  sha256: string;
  revision: string;
  license?: { name: string; url: string };
  capabilities?: string[];
  status: MarketStatus;
  enabled?: boolean;
  installedId?: string;
  installedVersion?: number;
  installedRevision?: string;
  localModified?: boolean;
  legacy?: boolean;
  updateAvailable?: boolean;
}
export interface MarketPreview {
  skill: MarketSkill;
  entry: PublicEntry & { body: string };
  update?: { id: string; version: number; revision: string };
  localBody?: string;
  requiresReplacement?: boolean;
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
  skill: 'Skills',
  command: 'Commands',
  mcp: 'MCP',
};
export const marks: Record<ExtensionKind, string> = { skill: '*', command: '/', mcp: '#' };
export const testLabels = { connected: '已连接', 'needs-auth': '需要认证', failed: '连接失败' };
export const marketLabels: Record<MarketStatus, string> = {
  available: '可安装',
  enabled: '已启用',
  disabled: '已停用',
  legacy: '旧版待迁移',
  'update-available': '有审核更新',
  'local-modified': '本地已修改',
  conflict: '同名冲突',
};
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。';
export const isConflict = (error: unknown) =>
  Boolean(error && typeof error === 'object' && 'status' in error && error.status === 409);
export const allowsAuto = (item?: MarkdownExtension) => item?.modelInvocable !== false;
export const autoEnabled = (item?: MarkdownExtension) =>
  allowsAuto(item) && item?.autoInvoke !== false;
export const needsMarketReview = (skill: MarketSkill) =>
  Boolean(
    skill.legacy ||
    skill.localModified ||
    skill.updateAvailable ||
    ['legacy', 'update-available', 'local-modified'].includes(skill.status),
  );
export const endpoint = (projectId: string, suffix?: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/extensions${suffix ? `/${suffix}` : ''}`;
export const extensionKeys = {
  all: (projectId: string) => ['extensions', projectId] as const,
  list: (projectId: string) => ['extensions', projectId, 'list'] as const,
  market: (projectId: string) => ['extensions', projectId, 'market'] as const,
  preview: (projectId: string, id: string) =>
    ['extensions', projectId, 'market-preview', id] as const,
  mutations: (projectId: string) => ['extensions', projectId, 'mutation'] as const,
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
export const marketQuery = (projectId: string) =>
  queryOptions({
    queryKey: extensionKeys.market(projectId),
    queryFn: async ({ signal }) => {
      const result = await api<{ items: MarketSkill[] }>(endpoint(projectId, 'market'), { signal });
      if (!Array.isArray(result?.items)) throw new Error('精选目录响应缺少 items，请重试。');
      return result.items;
    },
    staleTime: 0,
    enabled: Boolean(projectId),
    retry: false,
  });
export function useExtensions(projectId?: string) {
  return useQuery(extensionsQuery(projectId ?? ''));
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
      await Promise.all([
        client.cancelQueries({ queryKey: extensionKeys.list(projectId) }),
        client.cancelQueries({ queryKey: extensionKeys.market(projectId) }),
      ]);
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
      await Promise.all([
        client.invalidateQueries({ queryKey: extensionKeys.list(projectId) }),
        client.invalidateQueries({ queryKey: extensionKeys.market(projectId) }),
        client.invalidateQueries({ queryKey: ['extensions', projectId, 'market-preview'] }),
      ]);
    },
  });
}
