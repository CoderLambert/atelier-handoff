/**
 * @file 封装 MCP 连接测试及其目录缓存同步逻辑。
 * @implementation 触发测试并在传输配置一致时将成功或失败状态写回扩展列表缓存，同时提供按 ID 读缓存与强制刷新能力。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { useQueryClient } from '@tanstack/react-query';
import type { DiscoveredTool, Extension } from '@shared/extensions';
import { getTranslator, translateError } from '@/i18n';
import { extensionKeys } from './keys';
import { useExtensionMutation } from './use-extension-mutation';
import { extensionsQuery } from './use-extensions';

type McpExtension = Extract<Extension, { kind: 'mcp' }>;

export interface TestResult {
  status: 'connected' | 'needs-auth' | 'failed';
  tools: DiscoveredTool[];
  message?: string;
  statusMessage?: string;
  item?: Extension;
}

export function useExtensionCache(projectId: string) {
  const client = useQueryClient();
  return {
    getById(id: string): Extension | undefined {
      return client
        .getQueryData<Extension[]>(extensionKeys.list(projectId))
        ?.find((value) => value.id === id);
    },
    fetchLatestList(): Promise<Extension[]> {
      return client.fetchQuery({ ...extensionsQuery(projectId), staleTime: 0 });
    },
  };
}

export function useTestMcpExtension(
  projectId: string,
  formatError: (cause: unknown) => string = (cause) =>
    translateError(cause, getTranslator('extensions')('common.operationFailed')),
) {
  const client = useQueryClient();
  const test = useExtensionMutation<TestResult>(projectId);

  async function testExtension(
    target: McpExtension,
  ): Promise<{ result: TestResult; updatedItem?: McpExtension }> {
    const t = getTranslator('extensions');
    try {
      const result = await test.mutateAsync({
        suffix: `${encodeURIComponent(target.id)}/test`,
        method: 'POST',
        body: {},
      });
      if (
        !['connected', 'needs-auth', 'failed'].includes(result?.status) ||
        !Array.isArray(result.tools)
      ) {
        throw new Error(t('extensionEditor.invalidTest'));
      }
      const latest =
        client
          .getQueryData<Extension[]>(extensionKeys.list(projectId))
          ?.find((value) => value.id === target.id) ??
        result.item ??
        target;
      let updatedItem: McpExtension | undefined;
      // Older servers may return the test result without an item. Keep its status
      // alongside the current version so the picker never infers success from tools alone.
      if (
        latest.kind === 'mcp' &&
        JSON.stringify(latest.transport) === JSON.stringify(target.transport)
      ) {
        const updated: McpExtension = {
          ...latest,
          status: result.status,
          tools: result.tools,
          statusMessage: result.message ?? result.statusMessage ?? '',
        };
        client.setQueryData<Extension[]>(extensionKeys.list(projectId), (items) =>
          items?.map((value) => (value.id === target.id ? updated : value)),
        );
        updatedItem = updated;
      }
      return { result, updatedItem };
    } catch (cause) {
      client.setQueryData<Extension[]>(extensionKeys.list(projectId), (items) =>
        items?.map((value) =>
          value.id === target.id &&
          value.kind === 'mcp' &&
          JSON.stringify(value.transport) === JSON.stringify(target.transport)
            ? { ...value, status: 'failed', statusMessage: formatError(cause), tools: [] }
            : value,
        ),
      );
      throw cause;
    }
  }

  return {
    isPending: test.isPending,
    testExtension,
  };
}
