/**
 * @file 提供扩展界面的显示辅助方法和数据访问入口。
 * @implementation 重导出 use-query 扩展查询与变更接口，并基于共享诊断分类码将扩展详情与 GitHub 预览场景本地化。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { ApiError } from '@/api/client';
import { getTranslator, translateError } from '@/i18n';
import { classifyExtensionDiagnostic, type ExtensionDiagnosticCode } from '@shared/extensions';
import type { Extension, ExtensionSelection } from '@shared/types';

export { endpoint, extensionKeys, extensionPickerKeys } from '@/use-query/extensions/keys';
export {
  extensionsQuery,
  useExtensionPickerCatalog,
  useExtensions,
} from '@/use-query/extensions/use-extensions';
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
export { useSkillToolBindings } from '@/use-query/extensions/use-skill-tool-bindings';
export { useSaveSkillToolBindings } from '@/use-query/extensions/use-save-skill-tool-bindings';
export {
  useExtensionCache,
  useTestMcpExtension,
  type TestResult,
} from '@/use-query/extensions/use-test-mcp-extension';
export { useSkillHubSearch, type SkillHubItem } from '@/use-query/extensions/use-skillhub-search';

export type ExtensionKind = Extension['kind'];
export type McpExtension = Extract<Extension, { kind: 'mcp' }>;
export type MarkdownExtension = Exclude<Extension, McpExtension>;
export type StartSkill = (
  projectId: string,
  selection: ExtensionSelection,
  editable: boolean,
) => Promise<void>;
export type { PublicEntry } from '@shared/public-extensions';

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

const staticDiagnosticKeys = {
  invalid_frontmatter: 'extensionDetail.invalidFrontmatter',
  unclosed_frontmatter: 'extensionDetail.unclosedFrontmatter',
  empty_body: 'extensionDetail.emptyBody',
  unsupported_package: 'extensionDetail.unsupportedPackage',
  unsupported_markdown: 'extensionDetail.unsupportedMarkdown',
  manifest_encoding: 'publicImport.manifestEncoding',
  manifest_too_large: 'publicImport.manifestTooLarge',
  auth_required: 'extensionDetail.authRequired',
  connection_failed: 'extensionDetail.connectionFailed',
  process_limit: 'extensionDetail.processLimit',
  session_closed_retry: 'extensionDetail.sessionClosedRetry',
  session_closed: 'extensionDetail.sessionClosed',
  native_browser: 'extensionDetail.nativeBrowser',
  secret_metadata: 'extensionDetail.secretMetadata',
} as const satisfies Record<
  Exclude<ExtensionDiagnosticCode, 'discovered_tools' | 'environment_required'>,
  string
>;

/** Translate known application diagnostics; leave upstream text and identifiers intact. */
export function extensionDetail(
  message: string | undefined,
  context: 'detail' | 'github-preview' = 'detail',
): string {
  if (!message) return '';
  const classified = classifyExtensionDiagnostic(message);
  if (!classified) return message;
  const t = getTranslator('extensions');
  if (classified.code === 'discovered_tools')
    return t('extensionDetail.discovered', { count: classified.count });
  if (classified.code === 'environment_required')
    return t('extensionDetail.environmentRequired', { name: classified.name });
  if (classified.code === 'unsupported_package' && context === 'github-preview')
    return t('publicImport.githubCompatibility');
  return t(staticDiagnosticKeys[classified.code]);
}

export const isConflict = (error: unknown) =>
  Boolean(error && typeof error === 'object' && 'status' in error && error.status === 409);
export const allowsAuto = (item?: MarkdownExtension) => item?.modelInvocable !== false;
export const autoEnabled = (item?: MarkdownExtension) =>
  allowsAuto(item) && item?.autoInvoke !== false;
