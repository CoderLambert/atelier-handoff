/**
 * @file 管理项目绑定和目录可用性。
 * @implementation 重新核对项目根目录，拒绝私有数据目录并保留已绑定路径的回执与通知。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { AppError, now } from '../../../shared/errors.js';
import { authorizeRoot, inside } from '../../files.js';
import type { Store } from '../../store.js';
import { branchFor } from './branch.js';

export function createProjectService(
  store: Pick<Store, 'directory' | 'list' | 'put' | 'update' | 'event'>,
) {
  async function list() {
    return Promise.all(
      store.list('projects').map(async (project) => {
        let available = false;
        try {
          available = (await authorizeRoot(project.path)) === project.path;
        } catch {}
        return store.update('projects', project.id, {
          available,
          branch: available ? await branchFor(project.path) : project.branch,
        });
      }),
    );
  }

  async function bind(input: string) {
    const path = await authorizeRoot(input);
    if (inside(await realpath(store.directory), path))
      throw new AppError('PATH_DENIED', '不能把工作台私有数据目录绑定为项目。', 403);
    const existing = store.list('projects').find((p) => p.path === path);
    const project =
      existing ??
      store.put('projects', {
        id: randomUUID(),
        name: basename(path),
        path,
        branch: await branchFor(path),
        available: true,
        createdAt: now(),
      });
    store.event('project-' + project.id, '', 'project.bound', { projectId: project.id });
    return { project, created: !existing };
  }

  return { list, bind };
}

export type ProjectService = ReturnType<typeof createProjectService>;
