/**
 * @file 管理输入框键盘提交、快捷插话与输入法保护。
 * @implementation 组合期及结束后 50 毫秒内交还按键给输入法，其余按键先询问补全再决定提交动作。
 * @updated 2026-11-27T18:34:46+08:00
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

const compositionProtectionMs = 50;
export type ComposerKey = Pick<
  KeyboardEvent,
  'key' | 'isComposing' | 'keyCode' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>;

export function isComposerImeKey(
  event: ComposerKey,
  { active, until }: { active: boolean; until: number },
  now: number,
) {
  return active || event.isComposing || event.keyCode === 229 || now < until;
}

export function dispatchComposerKey(
  event: ComposerKey,
  {
    ime,
    completionConsumed,
    insertAvailable,
  }: {
    ime: boolean;
    completionConsumed?: boolean;
    insertAvailable: boolean;
  },
) {
  if (ime) return 'ime';
  if (completionConsumed) return 'completion';
  if (event.key !== 'Enter' || event.metaKey || event.shiftKey) return 'default';
  if (!event.ctrlKey && !event.altKey) return 'submit';
  if (insertAvailable && event.ctrlKey !== event.altKey) return event.repeat ? 'ignore' : 'insert';
  return 'default';
}

export function useComposerKeymap({
  insertRunId,
  consumeCompletion,
  onSubmit,
}: {
  insertRunId?: string;
  consumeCompletion: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
  onSubmit: (runId?: string) => void;
}) {
  const composition = useRef({ active: false, until: 0 });
  const [composing, setComposing] = useState(false);
  return {
    composing,
    onCompositionStart() {
      composition.current.active = true;
      setComposing(true);
    },
    onCompositionEnd() {
      composition.current = { active: false, until: Date.now() + compositionProtectionMs };
      setComposing(false);
    },
    onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
      if (event.defaultPrevented || event.currentTarget.disabled || event.currentTarget.readOnly)
        return;
      const ime = isComposerImeKey(event.nativeEvent, composition.current, Date.now());
      const action = dispatchComposerKey(event.nativeEvent, {
        ime,
        completionConsumed: !ime && consumeCompletion(event),
        insertAvailable: insertRunId !== undefined,
      });
      if (action === 'ime') {
        if (event.key === 'Enter') event.stopPropagation();
        return;
      }
      if (action === 'default' || action === 'completion') return;
      event.preventDefault();
      event.stopPropagation();
      if (action !== 'ignore') onSubmit(action === 'insert' ? insertRunId : undefined);
    },
  };
}
