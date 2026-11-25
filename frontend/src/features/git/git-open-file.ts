/**
 * @file 标识 Git 工作区中打开的文件版本。
 * @implementation 将工作树、比较来源、提交和路径组成稳定的阅读标签身份。
 * @updated 2026-11-25T17:10:00+08:00
 */
import type { GitFileContentTarget } from '@/use-query/git/use-git-file-content';

export interface GitOpenFile {
  target: GitFileContentTarget;
  worktreeId: string;
  revealPath?: string;
}

export function gitOpenFileKey({ target, worktreeId }: GitOpenFile) {
  return JSON.stringify([
    worktreeId,
    target.kind === 'history' ? target.commitOid : target.worktreeId,
    target.source,
    target.path,
  ]);
}
