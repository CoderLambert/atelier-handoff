/**
 * @file 创建人工终端测试的隔离会话和工作目录。
 * @implementation 使用真实临时 SQLite 和普通目录；进程替身仅替代 PTY 边界。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../server/store.js';
import { DevelopmentWorktrees } from '../../server/modules/git/development-worktrees.js';
import { emptyDraft, now, type Project, type Session } from '../../shared/types.js';

export async function terminalFixture() {
  const base = await mkdtemp(join(tmpdir(), 'atelier-terminal-'));
  const directory = join(base, 'project');
  await mkdir(directory);
  const store = new Store(join(base, 'data'));
  const project: Project = {
    id: randomUUID(),
    name: 'Terminal fixture',
    path: await realpath(directory),
    branch: '',
    available: true,
    createdAt: now(),
  };
  store.put('projects', project);
  const session: Session = {
    id: randomUUID(),
    projectId: project.id,
    title: 'Terminal',
    status: 'active',
    sdkSessionId: null,
    createdAt: now(),
    updatedAt: now(),
    draft: emptyDraft(),
  };
  store.put('sessions', session);
  const worktrees = new DevelopmentWorktrees(store, await realpath(store.directory), {
    inUse: () => false,
    closeDirectory: async () => {},
    released: () => {},
  });
  return {
    base,
    store,
    project,
    session,
    worktrees,
    async dispose() {
      store.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}
