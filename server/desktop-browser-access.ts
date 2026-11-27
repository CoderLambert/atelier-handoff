/**
 * @file 管理项目范围的原生浏览器授权。
 * @implementation 存储授权版本并撤销引用过期版本的在途调用。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.js';
import type {
  DesktopBrowserAccessState,
  DesktopBrowserAccessUpdate,
} from '../shared/desktop-browser.js';
import type { Store } from './store.js';

export class DesktopBrowserAccess {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly available: () => boolean,
  ) {}

  read(projectId: string): DesktopBrowserAccessState {
    const project = this.store.get('projects', projectId);
    return {
      available: this.available(),
      enabled: project.desktopBrowser?.enabled ?? false,
      revision: project.desktopBrowser?.revision ?? null,
    };
  }

  update(projectId: string, input: DesktopBrowserAccessUpdate): DesktopBrowserAccessState {
    const current = this.read(projectId);
    if (!current.available)
      throw new AppError('DESKTOP_BROWSER_UNAVAILABLE', '原生浏览器仅能在桌面工作台中授权。', 409);
    if (current.revision !== input.revision)
      throw new AppError('BROWSER_ACCESS_CHANGED', '浏览器授权已更新，请刷新后再试。', 409);
    if (current.enabled === input.enabled) return current;
    const policy = { enabled: input.enabled, revision: randomUUID() };
    this.store.update('projects', projectId, { desktopBrowser: policy });
    this.active.get(projectId)?.abort(this.denied());
    this.active.delete(projectId);
    return { available: true, ...policy };
  }

  signal(projectId: string, revision: string): AbortSignal {
    this.verify(projectId, revision);
    let controller = this.active.get(projectId);
    if (!controller) {
      controller = new AbortController();
      this.active.set(projectId, controller);
    }
    return controller.signal;
  }

  verify(projectId: string, revision: string): void {
    const state = this.read(projectId);
    if (!state.available || !state.enabled || revision !== state.revision) throw this.denied();
  }

  private denied(): AppError {
    return new AppError(
      'BROWSER_ACCESS_DENIED',
      '该项目的浏览器授权已关闭或更改，请发起新任务。',
      403,
    );
  }
}
