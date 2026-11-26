/**
 * @file 提供项目扩展、浏览器预览与公开 GitHub 连接 HTTP 接口。
 * @implementation 保留原有路径优先级和 JSON 校验，在公开来源读取和 MCP 测试期间跟踪客户端断连。
 * @updated 2026-11-26T23:33:05+08:00
 */
import { z } from 'zod';
import { githubPublicAuthPatch } from '../../../shared/github-public-auth.js';
import { publicImportSchema, publicPreviewSchema } from '../../../shared/public-extensions.js';
import { AppError, type SkillToolBinding } from '../../../shared/types.js';
import {
  createExtensionService,
  publicPreviewEntries,
  type ExtensionServiceOptions,
} from '../../modules/extensions/service.js';
import { searchSkillHub } from '../../skillhub.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

export interface ExtensionRoutesOptions extends ExtensionServiceOptions {
  skillToolBindings: {
    read(projectId: string, skillId: string): SkillToolBinding[];
    save(projectId: string, skillId: string, input: unknown): SkillToolBinding[];
  };
}

const skillHubQuery = z.string().trim().max(120);

export function createExtensionRoutes(options: ExtensionRoutesOptions): RouteHandler {
  const { extensions, getProject, githubPublicAuth, skillToolBindings } = options;
  const service = createExtensionService(options);

  return async ({ req, res, url, parts, method }) => {
    if (url.pathname === '/api/extensions/github-connection') {
      if (method === 'GET') return json(res, { login: githubPublicAuth.read() });
      if (method === 'PUT') {
        const { connect } = githubPublicAuthPatch.parse(await body(req));
        return json(res, { login: await service.setGithubConnection(connect) });
      }
    }

    const [api, projects, projectId, resource, id, action] = parts;
    if (api !== 'api' || projects !== 'projects' || projectId === undefined) return false;
    if (resource === 'browser-preview' && parts.length === 4 && method === 'POST')
      return json(res, {
        frame: await service.browserPreview(projectId, url.searchParams.get('frame') === '1'),
      });
    if (resource !== 'extensions') return false;

    if (parts.length === 4 && method === 'GET')
      return json(res, { items: service.listPublicExtensions(projectId) });
    if (parts.length === 4 && method === 'POST')
      return json(res, { item: extensions.save(projectId, await body(req)) }, 201);

    if (id !== undefined) {
      if (
        parts.length === 6 &&
        action === 'tool-bindings' &&
        (method === 'GET' || method === 'PUT')
      ) {
        service.requireSkill(projectId, id);
        const bindings =
          method === 'GET'
            ? skillToolBindings.read(projectId, id)
            : skillToolBindings.save(projectId, id, await body(req));
        return json(res, { bindings });
      }
      if (parts.length === 5 && id === 'skillhub-search' && method === 'GET') {
        getProject(projectId);
        const query = skillHubQuery.parse(url.searchParams.get('q') ?? '');
        return json(res, { items: await searchSkillHub(query) });
      }
      if (
        parts.length === 5 &&
        method === 'POST' &&
        (id === 'public-preview' || id === 'public-import')
      ) {
        getProject(projectId);
        const payload = await body(req);
        const importing = id === 'public-import' ? publicImportSchema.parse(payload) : undefined;
        const input = importing ?? publicPreviewSchema.parse(payload);
        if (importing) {
          const installed = service.installedPublicImport(projectId, importing);
          if (installed) return json(res, installed);
        }

        // 仅在读取公开来源时监听断连，安装发生在解除监听之后。
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.once('close', cancel);
        let items: Awaited<ReturnType<typeof service.fetchPublicEntries>>;
        try {
          items = await service.fetchPublicEntries(input, controller.signal);
          if (controller.signal.aborted) return true;
        } finally {
          res.off('close', cancel);
        }
        if (!importing) return json(res, { items: publicPreviewEntries(items) });
        const saved = await service.installPublicImport(projectId, importing, items);
        return json(res, saved, saved.changed && !importing.update ? 201 : 200);
      }
      if (parts.length === 5 && method === 'PATCH')
        return json(res, { item: await service.updateExtension(projectId, id, await body(req)) });
      if (parts.length === 5 && method === 'DELETE') {
        await service.removeExtension(projectId, id);
        return json(res, { ok: true });
      }
      if (parts.length === 6 && action === 'test' && method === 'POST') {
        await body(req);
        const runTest = await service.prepareMcpTest(projectId, id);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        res.once('close', cancel);
        try {
          const result = await runTest(controller.signal);
          return result ? json(res, result) : true;
        } finally {
          res.off('close', cancel);
        }
      }
    }
    throw new AppError('NOT_FOUND', '扩展接口不存在。', 404);
  };
}
