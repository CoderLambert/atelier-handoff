/**
 * @file 管理 Git 工作树写租约与终端工作目录占用预留。
 * @implementation 隔离互斥路径锁、仓库独占锁与可并发的终端目录预留状态，并在释放租约时通知队列调度。
 * @updated 2026-11-27T21:42:00+08:00
 */
import { inside } from '../../files.js';
import { gitError } from './git-cli.js';

export const directoriesOverlap = (a: string, b: string) => inside(a, b) || inside(b, a);

export class WorktreeLeaseManager {
  private readonly leases = new Map<string, string>();
  private readonly terminalReservations = new Map<symbol, string>();

  isPathBusy(path: string): boolean {
    return [...this.leases.values()].some((other) => directoriesOverlap(path, other));
  }

  hasTerminalReservation(path: string): boolean {
    return [...this.terminalReservations.values()].some((other) => directoriesOverlap(path, other));
  }

  assertUnlocked(path: string): void {
    if (this.isPathBusy(path)) throw gitError('DIRECTORY_BUSY', '工作目录正在处理 Git 操作。');
  }

  reserveTerminal(path: string): { isActive(): boolean; release(): void } {
    this.assertUnlocked(path);
    const token = Symbol('terminal');
    this.terminalReservations.set(token, path);
    return {
      isActive: () => this.terminalReservations.has(token),
      release: () => {
        this.terminalReservations.delete(token);
      },
    };
  }

  async runExclusive<T>(
    repositoryId: string,
    path: string,
    work: () => Promise<T>,
    onReleased?: () => void,
  ): Promise<T> {
    this.assertUnlocked(path);
    if (this.leases.has(repositoryId))
      throw gitError('DIRECTORY_BUSY', '同一仓库的另一项 Git 操作正在进行。');
    this.leases.set(repositoryId, path);
    try {
      return await work();
    } finally {
      this.leases.delete(repositoryId);
      onReleased?.();
    }
  }
}
