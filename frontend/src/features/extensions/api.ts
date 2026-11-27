/**
 * @file 提供扩展界面的显示辅助方法和数据访问入口。
 * @implementation 重导出扩展目录的查询层接口，保留技能工具绑定的遗留操作，并按扩展详情或 GitHub 预览场景本地化诊断。
 * @updated 2026-11-27T17:02:57+08:00
 */
import { getTranslator, translateError } from '@/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Extension, ExtensionSelection, SkillToolBinding } from '@shared/types';
import { api, ApiError } from '@/api/client';
import { endpoint, extensionKeys } from '@/use-query/extensions/keys';

export { endpoint, extensionKeys, extensionPickerKeys } from '@/use-query/extensions/keys';
export { extensionsQuery, useExtensions } from '@/use-query/extensions/use-extensions';
export {
  invalidateExtensionPickers,
  pickerCatalogItems,
  useInvalidateExtensionPickers,
} from '@/use-query/extensions/picker-cache';
export {
  extensionMutationOptions,
  returnedItem,
  useExtensionMutation,
  type ItemResponse,
} from '@/use-query/extensions/use-extension-mutation';

export type ExtensionKind = Extension['kind'];
export type McpExtension = Extract<Extension, { kind: 'mcp' }>;
export type MarkdownExtension = Exclude<Extension, McpExtension>;
export type StartSkill = (
  projectId: string,
  selection: ExtensionSelection,
  editable: boolean,
) => Promise<void>;
export type { PublicEntry } from '@shared/public-extensions';
export interface TestResult {
  status: 'connected' | 'needs-auth' | 'failed';
  tools: McpExtension['tools'];
  message?: string;
  statusMessage?: string;
  item?: Extension;
}

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

const publicSourceErrors = [
  ['PUBLIC_SOURCE_INVALID', 'publicImport.invalidSource'],
  ['PUBLIC_SOURCE_FAILED', 'publicImport.sourceFailed'],
  ['PUBLIC_SOURCE_HTTP', 'publicImport.sourceFailed'],
  ['PUBLIC_SOURCE_CHANGED', 'publicImport.sourceChanged'],
  ['PUBLIC_SOURCE_TOO_LARGE', 'publicImport.sourceTooLarge'],
  ['PUBLIC_SOURCE_EXISTS', 'publicImport.sourceExists'],
  ['GITHUB_LOGIN_REQUIRED', 'publicImport.githubLoginRequired'],
  ['GITHUB_PUBLIC_REPO_REQUIRED', 'publicImport.githubPublicOnly'],
  ['GITHUB_SKILL_RATE_LIMIT', 'publicImport.githubRateLimit'],
  ['GITHUB_SKILL_INVALID_MANIFEST', 'publicImport.manifestEncoding'],
  ['GITHUB_SKILL_NOT_FOUND', 'publicImport.githubNotFound'],
  ['GITHUB_SKILL_UNSUPPORTED', 'publicImport.githubUnsafeFiles'],
  ['GITHUB_SKILL_TRUNCATED', 'publicImport.githubTruncated'],
  ['EXTENSION_NAME_TAKEN', 'publicImport.nameTaken'],
  ['EXTENSION_CHANGED', 'publicImport.extensionChanged'],
  ['PUBLIC_LOCAL_MODIFIED', 'publicImport.localModified'],
] as const;

export function messageOf(error: unknown) {
  const t = getTranslator('extensions');
  if (error instanceof ApiError) {
    const key = publicSourceErrors.find(([code]) => code === error.code)?.[1];
    return key ? t(key) : translateError(error, t('common.operationFailed'));
  }
  if (error instanceof Error) {
    // These pinned legacy callbacks still throw source messages. Translate them at display time.
    for (const [source, key] of localResponseErrors) {
      if (error.message === source) return t(key);
    }
    return error.message;
  }
  return translateError(error, t('common.operationFailed'));
}
const extensionDiagnostics = [
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
  ['SKILL.md 必须使用 UTF-8 编码。', 'publicImport.manifestEncoding'],
  ['SKILL.md 超过读取上限。', 'publicImport.manifestTooLarge'],
  ['MCP 服务要求有效的凭据。', 'extensionDetail.authRequired'],
  ['MCP 连接或调用失败。请检查地址、进程参数和服务端日志。', 'extensionDetail.connectionFailed'],
  ['已打开 8 个常驻 MCP。停用不再使用的服务后重试。', 'extensionDetail.processLimit'],
  ['MCP 会话已关闭，请重新发起工具调用。', 'extensionDetail.sessionClosedRetry'],
  ['MCP 会话已关闭。', 'extensionDetail.sessionClosed'],
  ['请使用桌面内置浏览器工具。', 'extensionDetail.nativeBrowser'],
  ['MCP 工具描述包含配置中的凭据，请修改服务端工具定义。', 'extensionDetail.secretMetadata'],
] as const;
const extensionMessages = new Map<string, (typeof extensionDiagnostics)[number][1]>(
  extensionDiagnostics,
);

/** Translate known application diagnostics; leave upstream text and identifiers intact. */
export function extensionDetail(
  message: string | undefined,
  context: 'detail' | 'github-preview' = 'detail',
): string {
  if (!message) return '';
  const t = getTranslator('extensions');
  const key = extensionMessages.get(message);
  if (key === 'extensionDetail.unsupportedPackage' && context === 'github-preview')
    return t('publicImport.githubCompatibility');
  if (key) return t(key);
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
