/**
 * @file 预览开发会话的分支、基线与目标目录。
 * @implementation 发送只读校验请求并保留运行时解析的提交 SHA。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { DevelopmentPreview, GitDevelopmentPreview } from '@shared/git-workbench';
import { gitUrl } from './keys';

export function usePreviewDevelopmentSession(projectId: string) {
  return useMutation({
    mutationFn: (body: DevelopmentPreview) =>
      api<GitDevelopmentPreview>(gitUrl(projectId) + '/preview', { method: 'POST', body }),
  });
}
