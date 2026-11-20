/**
 * @file 提供会话消息发送操作。
 * @implementation 发送带幂等键及可选单次自动审批配置的草稿，返回新运行。
 * @updated 2026-11-20T14:44:21+08:00
 */
import { useMutation } from '@tanstack/react-query';
import type { Draft, Run } from '@shared/types';
import { api } from '@/api/client';
import { sessionKeys } from './keys';

export type SessionMessageBody = Draft & {
  idempotencyKey: string;
  approvalMode?: 'automatic';
  maxSearchChargeFen?: number;
};
export interface SendSessionMessageInput {
  sessionId: string;
  body: SessionMessageBody;
}
export type SendSessionMessage = (input: SendSessionMessageInput) => Promise<{ run: Run }>;

export const sendSessionMessage: SendSessionMessage = ({ sessionId, body }) =>
  api<{ run: Run }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    body,
  });

export function useSendSessionMessage() {
  return useMutation({
    mutationKey: sessionKeys.sendMessage,
    mutationFn: sendSessionMessage,
    retry: false,
  });
}
