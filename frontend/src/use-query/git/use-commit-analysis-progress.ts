/**
 * @file 读取 AI 多提交的实时分析进度。
 * @implementation 按项目、工作树、快照和分析编号轮询运行时的统计，弹窗结束即停止。
 * @updated 2026-11-24T22:02:00+08:00
 */
import { skipToken, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import {
  multiCommitProgressResponse,
  type MultiCommitProgressRequest,
} from '@shared/git-multi-commit';
import { gitKeys, gitTreeUrl } from './keys';

export function useCommitAnalysisProgress(
  projectId: string,
  treeId: string,
  input?: MultiCommitProgressRequest,
) {
  return useQuery({
    queryKey: gitKeys.analysisProgress(projectId, treeId, input?.analysisId, input?.version),
    queryFn: input
      ? async ({ signal }) =>
          multiCommitProgressResponse.parse(
            await api(
              gitTreeUrl(projectId, treeId) +
                '/commit-analysis-progress?' +
                new URLSearchParams(input),
              { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) },
            ),
          )
      : skipToken,
    refetchInterval: input ? 900 : false,
    refetchOnWindowFocus: false,
    retry: false,
    gcTime: 0,
  });
}
