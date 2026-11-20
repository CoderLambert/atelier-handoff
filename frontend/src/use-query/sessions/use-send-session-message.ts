/**
 * @file 提供会话消息发送操作。
 * @implementation 发送带幂等键及可选单次自动审批配置的草稿，接收新运行或排队消息并刷新发起会话快照。
 * @updated 2026-11-20T23:09:03+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Draft, SendSessionMessageResult } from '@shared/types';
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
export type SendSessionMessage = (
  input: SendSessionMessageInput,
) => Promise<SendSessionMessageResult>;

export const sendSessionMessage: SendSessionMessage = ({ sessionId, body }) =>
  api<SendSessionMessageResult>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    body,
  });

export function useSendSessionMessage() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: sessionKeys.sendMessage,
    mutationFn: sendSessionMessage,
    retry: false,
    onSuccess: (_result, { sessionId }) => {
      void client.invalidateQueries({ queryKey: sessionKeys.snapshot(sessionId), exact: true });
    },
  });
}
