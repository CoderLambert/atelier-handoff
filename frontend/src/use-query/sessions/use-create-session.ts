/**
 * @file 创建项目会话。
 * @implementation 首次发送携带草稿 UUID，允许在创建响应丢失时复用同一记录。
 * @updated 2026-11-28T15:40:00+08:00
 */
import { useMutation } from '@tanstack/react-query';
import type { Session } from '@shared/types';
import { api } from '@/api/client';

export function useCreateSession() {
  return useMutation({
    mutationFn: (body: { projectId: string; draftId?: string }) =>
      api<{ session: Session }>('/api/sessions', { method: 'POST', body }),
    retry: false,
  });
}
