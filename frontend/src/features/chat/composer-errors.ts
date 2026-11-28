/**
 * @file 将聊天输入框的操作错误映射成界面提示。
 * @implementation 区分附件、发送和局部提示，并沿用共享错误码翻译。
 * @updated 2026-11-28T18:00:00+08:00
 */
import { translateError, type useUiTranslation } from '@/i18n';
import type { AttachmentActionError } from './hooks/use-composer-attachments';

export type ComposerError =
  | { type: 'attachment'; error: AttachmentActionError }
  | { type: 'send'; cause: unknown }
  | {
      type: 'notice';
      key: 'composer.attachmentsDisabled' | 'composer.dropBusy' | 'composer.pasteBusy';
    };

export function composerErrorText(
  error: ComposerError | undefined,
  t: ReturnType<typeof useUiTranslation<'chat'>>['t'],
): string {
  return error
    ? error.type === 'notice'
      ? t(error.key)
      : error.type === 'send'
        ? translateError(error.cause, t('composer.sendUnconfirmed'))
        : error.error.type === 'limit'
          ? t('attachment.limit')
          : translateError(error.error.cause, t('attachment.removeFailed'))
    : '';
}
