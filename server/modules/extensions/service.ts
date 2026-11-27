/**
 * @file 组织项目扩展的公开视图、来源安装与 MCP 管理操作。
 * @implementation 投影包清单而不暴露文件内容，协调来源版本校验、MCP 连接释放和可取消的测试记录。
 * @updated 2026-11-26T23:27:56+08:00
 */
import type { PublicImportInput, PublicPreviewInput } from '../../../shared/public-extensions.js';
import { AppError, type Extension, type Project } from '../../../shared/types.js';
import { testMcp, type McpSessions } from '../../extension-mcp.js';
import { inspectMarkdown, type ProjectExtensions } from '../../extensions.js';
import { resolveProjectPath } from '../../files.js';
import { authenticatedGithubFetch, currentGithubLogin } from '../../github-public-auth.js';
import { previewPublic, type PublicEntry } from '../../public-extensions.js';

export interface ExtensionServiceOptions {
  extensions: Pick<
    ProjectExtensions,
    | 'list'
    | 'selectionCatalog'
    | 'get'
    | 'save'
    | 'remove'
    | 'installedGithubVersion'
    | 'savePublic'
    | 'recordTest'
  >;
  mcpSessions: Pick<McpSessions, 'close' | 'preview'>;
  getProject(projectId: string): Pick<Project, 'path'>;
  githubPublicAuth: {
    read(): string | null;
    save(login: string | null): void;
  };
  publicSourceFetch?: typeof fetch;
}

function publicExtension(item: Extension) {
  if (item.kind === 'mcp' || !item.package) return item;
  const { package: pkg, ...fields } = item;
  return {
    ...fields,
    packageManifest: {
      digest: pkg.digest,
      files: pkg.files.map((file) => file.path),
      ...(item.origin?.github
        ? { executables: pkg.files.filter((file) => file.executable).map((file) => file.path) }
        : {}),
    },
  };
}

export function publicPreviewEntries(items: PublicEntry[]) {
  return items.map(({ package: pkg, ...entry }) =>
    pkg
      ? {
          ...entry,
          packageManifest: { digest: pkg.digest, files: pkg.files.map((file) => file.path) },
        }
      : entry,
  );
}

function isGithubSkill(input: PublicPreviewInput) {
  return input.kind === 'skill' && !input.source.startsWith('skillhub:');
}

export function createExtensionService({
  extensions,
  mcpSessions,
  getProject,
  githubPublicAuth,
  publicSourceFetch,
}: ExtensionServiceOptions) {
  async function setGithubConnection(connect: boolean) {
    const login = connect ? await currentGithubLogin() : null;
    githubPublicAuth.save(login);
    return login;
  }

  function listPublicExtensions(projectId: string) {
    return extensions
      .list(projectId)
      .map((item) =>
        publicExtension(
          item.kind === 'skill' && item.modelInvocable === undefined
            ? { ...item, modelInvocable: inspectMarkdown(item.body, item.package).modelInvocable }
            : item,
        ),
      );
  }

  function browserPreview(projectId: string, includeImage: boolean) {
    getProject(projectId);
    const enabled = extensions
      .list(projectId)
      .filter(
        (item) =>
          item.kind === 'mcp' &&
          item.enabled &&
          item.allowedTools.some(({ name }) => name === 'browser_navigate'),
      );
    return mcpSessions.preview(projectId, new Set(enabled.map(({ id }) => id)), includeImage);
  }

  function requireSkill(projectId: string, id: string) {
    if (extensions.get(projectId, id).kind !== 'skill')
      throw new AppError('INVALID_INPUT', '请选择 Skill。');
  }

  function installedPublicImport(projectId: string, input: PublicImportInput) {
    if (!isGithubSkill(input)) return;
    if (!input.github || !input.packageDigest)
      throw new AppError('PUBLIC_SOURCE_CHANGED', '请重新预览 GitHub Skill 后安装。', 409);
    const installed = extensions.installedGithubVersion(projectId, input);
    if (installed) return { item: publicExtension(installed), changed: false };
  }

  function fetchPublicEntries(input: PublicPreviewInput | PublicImportInput, signal: AbortSignal) {
    const githubSkill = isGithubSkill(input);
    const importing = 'revision' in input;
    const login = githubSkill ? githubPublicAuth.read() : null;
    const request = publicSourceFetch ?? fetch;
    return previewPublic(
      input.source,
      input.kind,
      login ? authenticatedGithubFetch(login, request) : request,
      {
        includePackage: !githubSkill || importing,
        github: input.github,
        packageDigest: importing ? input.packageDigest : undefined,
        signal,
      },
    );
  }

  async function installPublicImport(
    projectId: string,
    input: PublicImportInput,
    items: PublicEntry[],
  ) {
    const item = items.find(
      (entry) =>
        entry.key === input.key &&
        entry.revision === input.revision &&
        entry.package?.digest === input.packageDigest,
    );
    if (!item || !item.revision)
      throw new AppError('PUBLIC_SOURCE_CHANGED', '公开来源已更新，请重新预览。', 409);
    const saved = extensions.savePublic(projectId, item, input.update);
    if (saved.changed && saved.item.kind === 'mcp') await mcpSessions.close(saved.item.id);
    return { ...saved, item: publicExtension(saved.item) };
  }

  async function updateExtension(projectId: string, id: string, input: unknown) {
    const previous = extensions.get(projectId, id);
    const item = extensions.save(projectId, input, id);
    if (
      previous.kind === 'mcp' &&
      (item.kind !== 'mcp' ||
        !item.enabled ||
        JSON.stringify(item.transport) !== JSON.stringify(previous.transport))
    )
      await mcpSessions.close(id);
    return publicExtension(item);
  }

  async function removeExtension(projectId: string, id: string) {
    extensions.remove(projectId, id);
    await mcpSessions.close(id);
  }

  async function prepareMcpTest(projectId: string, id: string) {
    const item = extensions.get(projectId, id);
    if (item.kind !== 'mcp') throw new AppError('NOT_MCP', '请选择 MCP 服务。');
    const { path } = getProject(projectId);
    await resolveProjectPath(path, '', { directory: true });
    // 先验证目录，由调用方在连接测试开始前绑定取消信号。
    return async (signal: AbortSignal) => {
      const result = await testMcp(
        item,
        path,
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      );
      if (signal.aborted) return;
      return {
        ...result,
        message: result.statusMessage,
        item: extensions.recordTest(item, result),
      };
    };
  }

  return {
    setGithubConnection,
    listPublicExtensions,
    browserPreview,
    requireSkill,
    installedPublicImport,
    fetchPublicEntries,
    installPublicImport,
    updateExtension,
    removeExtension,
    prepareMcpTest,
  };
}
