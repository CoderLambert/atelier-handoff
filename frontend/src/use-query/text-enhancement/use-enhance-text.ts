/**
 * @file 请求单次文本增强。
 * @implementation 发送当前正文和用途，透传取消信号并校验返回正文。
 * @updated 2026-11-28T18:00:00+08:00
 */
import { useMutation } from '@tanstack/react-query';
import { textEnhancementResult, type TextEnhancementRequest } from '@shared/text-enhancement';
import { api } from '@/api/client';

export function useEnhanceText() {
  return useMutation({
    retry: false,
    mutationFn: async ({ input, signal }: { input: TextEnhancementRequest; signal: AbortSignal }) =>
      textEnhancementResult.parse(
        await api('/api/text-enhancements', { method: 'POST', body: input, signal }),
      ),
  });
}
