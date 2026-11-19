import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Extension, ExtensionSelection, McpTransport, SkillToolBinding } from '@shared/types';
import { api } from '@/api/client';

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
  skill: 'Skills',
  command: 'Commands',
  mcp: 'MCP',
};
export const marks: Record<ExtensionKind, string> = { skill: '*', command: '/', mcp: '#' };
export const testLabels = { connected: '已连接', 'needs-auth': '需要认证', failed: '连接失败' };
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。';
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
  if (!Array.isArray(result?.bindings)) throw new Error('工具绑定响应缺少 bindings。');
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
