/**
 * @file 提供工作区初始化引导数据查询。
 * @implementation 通过统一查询键拉取项目、会话、配置与事件游标，集中管理工作区引导缓存。
 * @updated 2026-11-27T19:25:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { bootstrap } from '@/api/client';
import { keys } from '@/app/events';

export function useBootstrap() {
  return useQuery({
    queryKey: keys.bootstrap,
    queryFn: bootstrap,
    staleTime: 30_000,
  });
}
