/**
 * @file 管理任意受控文本编辑器的增强和单次撤销。
 * @implementation 绑定编辑目标、原文和请求标识，使用同步比较写入防止迟到结果覆盖草稿。
 * @updated 2026-11-28T18:00:00+08:00
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { textEnhancementRequest, type TextEnhancementRequest } from '@shared/text-enhancement';
import { useEnhanceText } from '@/use-query/text-enhancement/use-enhance-text';

interface TextEnhancementOptions {
  target: string;
  kind: TextEnhancementRequest['kind'];
  text: string;
  disabled?: boolean;
  // Compare against the editor's latest value and write synchronously if it still matches.
  onReplace: (expected: string, replacement: string) => boolean;
}

interface AppliedEnhancement {
  target: string;
  kind: TextEnhancementOptions['kind'];
  original: string;
  result: string;
}

export function useTextEnhancement({
  target,
  kind,
  text,
  disabled = false,
  onReplace,
}: TextEnhancementOptions) {
  const request = useRef<AbortController | undefined>(undefined);
  const replace = useRef(onReplace);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ cause: unknown }>();
  const [applied, setApplied] = useState<AppliedEnhancement>();
  const { mutateAsync } = useEnhanceText();

  useLayoutEffect(() => {
    replace.current = onReplace;
  }, [onReplace]);

  const cancel = useCallback(() => {
    const active = request.current;
    if (!active) return;
    request.current = undefined;
    active.abort();
    setPending(false);
  }, []);

  useLayoutEffect(() => {
    cancel();
    setError(undefined);
  }, [target, kind, text, disabled, cancel]);

  useLayoutEffect(() => {
    setApplied((previous) =>
      previous?.target === target && previous.kind === kind && previous.result === text
        ? previous
        : undefined,
    );
  }, [target, kind, text]);

  useLayoutEffect(
    () => () => {
      request.current?.abort();
      request.current = undefined;
    },
    [],
  );

  const input = { kind, text };
  const canEnhance = !disabled && textEnhancementRequest.safeParse(input).success;
  const canUndo =
    !disabled &&
    !pending &&
    applied?.target === target &&
    applied.kind === kind &&
    applied.result === text;

  async function enhance() {
    if (!canEnhance || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(undefined);
    try {
      const { text: result } = await mutateAsync({ input, signal: controller.signal });
      if (request.current !== controller) return;
      if (result !== text && replace.current(text, result)) {
        setApplied({ target, kind, original: text, result });
      }
      request.current = undefined;
      setPending(false);
    } catch (cause) {
      if (request.current !== controller) return;
      request.current = undefined;
      setPending(false);
      setError({ cause });
    }
  }

  function undo() {
    if (!canUndo || request.current) return;
    replace.current(applied.result, applied.original);
    setApplied(undefined);
    setError(undefined);
  }

  return { pending, error, canEnhance, canUndo, enhance, cancel, undo };
}
