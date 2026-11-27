/**
 * @file 定义项目扩展的数据结构、统一前后端校验契约及结构化诊断分类。
 * @implementation 提供零 Node 依赖的浏览器安全校验函数、单一 Zod 输入模型以及前后端共用的诊断原文与分类码。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { z } from 'zod';

export const githubSkillVersionSchema = z.object({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  ref: z.string().min(1).max(1024),
  path: z.string().max(1024),
});
export type GithubSkillVersion = z.infer<typeof githubSkillVersionSchema>;

export interface ExtensionSelection {
  id: string;
  version: number;
  tools?: string[];
}

export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface AllowedMcpTool {
  name: string;
  access: 'read' | 'approval';
}

export type McpTransport =
  | { type: 'http'; url: string; tokenEnv?: string }
  | { type: 'stdio'; command: string; args: string[]; envNames: string[]; keepAlive?: boolean };

export interface ExtensionOrigin {
  location: string;
  key: string;
  revision: string;
  sha256?: string;
  upstreamVersion?: string;
  github?: GithubSkillVersion;
  packageDigest?: string;
  importedName?: string;
  importedDescription?: string;
}

export interface ExtensionBase {
  id: string;
  projectId: string;
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  version: number;
  origin?: ExtensionOrigin;
}

export interface SkillPackage {
  digest: string;
  files: { path: string; data: string; executable?: boolean }[];
}

export type Extension = ExtensionBase &
  (
    | {
        kind: 'command' | 'skill';
        body: string;
        supported: boolean;
        compatibility?: string;
        userInvocable: boolean;
        modelInvocable?: boolean;
        autoInvoke?: boolean;
        package?: SkillPackage;
      }
    | {
        kind: 'mcp';
        provider?: 'mcp' | 'playwright-browser';
        browserOrigins?: string[];
        autoUseInChat?: boolean;
        shareAcrossProjects?: boolean;
        transport: McpTransport;
        allowedTools: AllowedMcpTool[];
        tools: DiscoveredTool[];
        status?: 'connected' | 'needs-auth' | 'failed';
        statusMessage?: string;
      }
  );

export type SkillToolBinding =
  | { name: string; kind: 'builtin'; tool: 'list_files' | 'search_files' | 'publish_artifact' }
  | { name: string; kind: 'mcp'; extensionId: string; tool: string }
  | { name: string; kind: 'http'; url: string; parameter: string; description: string }
  | { name: string; kind: 'command'; preset: 'pdftotext' };

export interface UsedExtension {
  id: string;
  kind: Extension['kind'];
  name: string;
  version: number;
  source?: 'atelier' | 'workspace' | 'host';
  tools?: string[];
}

export function retainedSkillSelections(
  extensions: UsedExtension[] | undefined,
): ExtensionSelection[] {
  return (extensions ?? [])
    .filter(({ kind }) => kind === 'skill')
    .map(({ id, version }) => ({ id, version }));
}

export const EXTENSION_NAME_MAX = 64;
export const EXTENSION_DESCRIPTION_MAX = 500;
export const EXTENSION_SOURCE_MAX = 4096;
export const EXTENSION_BODY_MAX = 65000;
export const EXTENSION_URL_MAX = 2048;
export const EXTENSION_COMMAND_MAX = 4096;
export const EXTENSION_ARGS_MAX = 40;
export const EXTENSION_ARG_LENGTH_MAX = 2048;
export const EXTENSION_ENV_NAME_MAX = 128;
export const EXTENSION_ENV_NAMES_MAX = 20;
export const EXTENSION_ALLOWED_TOOLS_MAX = 40;

export const extensionNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const extensionEnvNamePattern = /^[A-Z_][A-Z0-9_]{0,127}$/;
export const extensionToolNamePattern = /^[A-Za-z0-9_.-]{1,128}$/;

export function isAbsoluteExecutablePath(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/])/.test(value) && !value.includes('\0');
}

export function checkMcpHttpUrl(raw: string): 'ok' | 'invalid' | 'unsafe' {
  if (!raw || raw.length > EXTENSION_URL_MAX) return 'invalid';
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    return 'invalid';
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  ) {
    return 'unsafe';
  }
  return 'ok';
}

export const extensionNameSchema = z.string().trim().regex(extensionNamePattern);
export const extensionEnvNameSchema = z.string().regex(extensionEnvNamePattern);
export const extensionToolNameSchema = z.string().regex(extensionToolNamePattern);
export const extensionVersionSchema = z.number().int().positive();

export const extensionSelectionsSchema = z
  .array(
    z.object({
      id: z.string().uuid(),
      version: extensionVersionSchema,
      tools: z.array(extensionToolNameSchema).max(EXTENSION_ALLOWED_TOOLS_MAX).optional(),
    }),
  )
  .max(12);

const sharedInputFields = {
  name: extensionNameSchema,
  description: z.string().trim().max(EXTENSION_DESCRIPTION_MAX).default(''),
  enabled: z.boolean().default(false),
};

export const mcpHttpTransportSchema = z
  .object({
    type: z.literal('http'),
    url: z.string().url().max(EXTENSION_URL_MAX),
    tokenEnv: extensionEnvNameSchema.optional(),
  })
  .superRefine(({ url }, ctx) => {
    if (checkMcpHttpUrl(url) !== 'ok') {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: '请输入 HTTPS 或本机 HTTP 地址，凭据使用环境变量。',
      });
    }
  });

export const mcpStdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z
    .string()
    .max(EXTENSION_COMMAND_MAX)
    .refine(isAbsoluteExecutablePath, '请输入可执行文件的绝对路径。'),
  args: z.array(z.string().max(EXTENSION_ARG_LENGTH_MAX)).max(EXTENSION_ARGS_MAX),
  envNames: z.array(extensionEnvNameSchema).max(EXTENSION_ENV_NAMES_MAX),
  keepAlive: z.boolean().optional(),
});

export const mcpTransportSchema = z.union([mcpHttpTransportSchema, mcpStdioTransportSchema]);

export const markdownExtensionInputSchema = z.object({
  ...sharedInputFields,
  kind: z.enum(['command', 'skill']),
  source: z.string().max(EXTENSION_SOURCE_MAX).default('本机'),
  body: z.string().min(1).max(EXTENSION_BODY_MAX),
  autoInvoke: z.boolean().optional(),
});

export const mcpExtensionInputSchema = z.object({
  ...sharedInputFields,
  kind: z.literal('mcp'),
  autoUseInChat: z.boolean().optional(),
  shareAcrossProjects: z.boolean().optional(),
  transport: mcpTransportSchema,
  allowedTools: z
    .array(z.object({ name: extensionToolNameSchema, access: z.enum(['read', 'approval']) }))
    .max(EXTENSION_ALLOWED_TOOLS_MAX)
    .default([]),
});

export const extensionInputSchema = z.union([
  markdownExtensionInputSchema,
  mcpExtensionInputSchema,
]);

export type ExtensionInput = z.infer<typeof extensionInputSchema>;

export type ExtensionValidationCode =
  | 'invalid_name'
  | 'description_too_long'
  | 'source_too_long'
  | 'body_required'
  | 'body_too_long'
  | 'invalid_url'
  | 'unsafe_url'
  | 'invalid_token_env'
  | 'invalid_env_name'
  | 'too_many_env_names'
  | 'invalid_command'
  | 'invalid_args'
  | 'too_many_args'
  | 'invalid_input';

function classifyValidationIssue(
  issue: z.ZodIssue,
  raw: unknown,
): ExtensionValidationCode | undefined {
  const path = issue.path;
  const field = path[0];
  if (field === 'name') return 'invalid_name';
  if (field === 'description') return 'description_too_long';
  if (field === 'source') return 'source_too_long';
  if (field === 'body') {
    return issue.code === 'too_small' ? 'body_required' : 'body_too_long';
  }
  if (field === 'transport') {
    const nested = path[1];
    if (nested === 'url') {
      const url =
        typeof raw === 'object' &&
        raw !== null &&
        'transport' in raw &&
        typeof raw.transport === 'object' &&
        raw.transport !== null &&
        'url' in raw.transport &&
        typeof raw.transport.url === 'string'
          ? raw.transport.url
          : '';
      return checkMcpHttpUrl(url) === 'unsafe' ? 'unsafe_url' : 'invalid_url';
    }
    if (nested === 'tokenEnv') return 'invalid_token_env';
    if (nested === 'command') return 'invalid_command';
    if (nested === 'envNames') {
      return path.length === 2 && issue.code === 'too_big'
        ? 'too_many_env_names'
        : 'invalid_env_name';
    }
    if (nested === 'args') {
      return path.length === 2 && issue.code === 'too_big' ? 'too_many_args' : 'invalid_args';
    }
  }
  return undefined;
}

function selectUnionBranchIssues(error: z.ZodError, raw: unknown): readonly z.ZodIssue[] {
  const kind =
    typeof raw === 'object' && raw !== null && 'kind' in raw && typeof raw.kind === 'string'
      ? raw.kind
      : undefined;
  const transportType =
    typeof raw === 'object' &&
    raw !== null &&
    'transport' in raw &&
    typeof raw.transport === 'object' &&
    raw.transport !== null &&
    'type' in raw.transport &&
    typeof raw.transport.type === 'string'
      ? raw.transport.type
      : undefined;
  const flattened: z.ZodIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'invalid_union') {
      for (const branch of issue.errors) {
        const matchesKind =
          !kind ||
          !branch.some(
            (sub) =>
              sub.path.length === 1 && sub.path[0] === 'kind' && sub.code === 'invalid_value',
          );
        const matchesTransport =
          !transportType ||
          !branch.some(
            (sub) =>
              sub.path.length === 2 &&
              sub.path[0] === 'transport' &&
              sub.path[1] === 'type' &&
              sub.code === 'invalid_value',
          );
        if (matchesKind && matchesTransport) {
          flattened.push(...branch);
        }
      }
    } else {
      flattened.push(issue);
    }
  }
  return flattened.length ? flattened : error.issues;
}

export function validateExtensionInput(
  raw: unknown,
):
  | { ok: true; data: ExtensionInput }
  | { ok: false; code: ExtensionValidationCode; error: z.ZodError } {
  const parsed = extensionInputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = selectUnionBranchIssues(parsed.error, raw);
  for (const issue of issues) {
    const code = classifyValidationIssue(issue, raw);
    if (code) return { ok: false, code, error: parsed.error };
  }
  return { ok: false, code: 'invalid_input', error: parsed.error };
}

export const extensionDiagnosticMessages = {
  invalidFrontmatter: 'Markdown frontmatter 格式无效。',
  unclosedFrontmatter: 'Markdown frontmatter 缺少结束标记。',
  emptyBody: '请填写扩展说明正文。',
  unsupportedPackage: '此扩展包含动态命令、钩子、专用权限配置或包中不存在的附属文件。',
  unsupportedMarkdown:
    '此扩展依赖 Claude Code 的动态命令、脚本、附属文件或专用工具配置。当前支持独立 Markdown 说明。',
  manifestEncoding: 'SKILL.md 必须使用 UTF-8 编码。',
  manifestTooLarge: 'SKILL.md 超过读取上限。',
  authRequired: 'MCP 服务要求有效的凭据。',
  connectionFailed: 'MCP 连接或调用失败。请检查地址、进程参数和服务端日志。',
  processLimit: '已打开 8 个常驻 MCP。停用不再使用的服务后重试。',
  sessionClosedRetry: 'MCP 会话已关闭，请重新发起工具调用。',
  sessionClosed: 'MCP 会话已关闭。',
  nativeBrowser: '请使用桌面内置浏览器工具。',
  secretMetadata: 'MCP 工具描述包含配置中的凭据，请修改服务端工具定义。',
} as const;

export type ExtensionDiagnosticCode =
  | 'invalid_frontmatter'
  | 'unclosed_frontmatter'
  | 'empty_body'
  | 'unsupported_package'
  | 'unsupported_markdown'
  | 'manifest_encoding'
  | 'manifest_too_large'
  | 'auth_required'
  | 'connection_failed'
  | 'process_limit'
  | 'session_closed_retry'
  | 'session_closed'
  | 'native_browser'
  | 'secret_metadata'
  | 'discovered_tools'
  | 'environment_required';

const staticDiagnosticMap = new Map<string, ExtensionDiagnosticCode>([
  [extensionDiagnosticMessages.invalidFrontmatter, 'invalid_frontmatter'],
  [extensionDiagnosticMessages.unclosedFrontmatter, 'unclosed_frontmatter'],
  [extensionDiagnosticMessages.emptyBody, 'empty_body'],
  [extensionDiagnosticMessages.unsupportedPackage, 'unsupported_package'],
  [extensionDiagnosticMessages.unsupportedMarkdown, 'unsupported_markdown'],
  [extensionDiagnosticMessages.manifestEncoding, 'manifest_encoding'],
  [extensionDiagnosticMessages.manifestTooLarge, 'manifest_too_large'],
  [extensionDiagnosticMessages.authRequired, 'auth_required'],
  [extensionDiagnosticMessages.connectionFailed, 'connection_failed'],
  [extensionDiagnosticMessages.processLimit, 'process_limit'],
  [extensionDiagnosticMessages.sessionClosedRetry, 'session_closed_retry'],
  [extensionDiagnosticMessages.sessionClosed, 'session_closed'],
  [extensionDiagnosticMessages.nativeBrowser, 'native_browser'],
  [extensionDiagnosticMessages.secretMetadata, 'secret_metadata'],
]);

export type ClassifiedExtensionDiagnostic =
  | { code: Exclude<ExtensionDiagnosticCode, 'discovered_tools' | 'environment_required'> }
  | { code: 'discovered_tools'; count: number }
  | { code: 'environment_required'; name: string };

export function classifyExtensionDiagnostic(
  message: string | undefined,
): ClassifiedExtensionDiagnostic | undefined {
  if (!message) return undefined;
  const staticCode = staticDiagnosticMap.get(message);
  if (staticCode) {
    return {
      code: staticCode as Exclude<
        ExtensionDiagnosticCode,
        'discovered_tools' | 'environment_required'
      >,
    };
  }
  const discovered = /^已发现 (\d+) 项工具。$/.exec(message);
  if (discovered) {
    return { code: 'discovered_tools', count: Number(discovered[1]) };
  }
  const environment = /^请在本机服务环境中设置 ([A-Za-z_][A-Za-z0-9_]*)。$/.exec(message);
  if (environment?.[1]) {
    return { code: 'environment_required', name: environment[1] };
  }
  return undefined;
}
