/**
 * @file 管理元素悬停延迟、防快速划过与滚动自动隐藏的交互逻辑。
 * @implementation 维持 400ms 定时器、提供进入/离开/滚动清理，通过 DOMRect 计算浮层锚点。
 * @updated 2026-11-25T03:25:00+08:00
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface HoverAnchor<T> {
  item: T;
  rect: DOMRect;
}

export function useHoverCard<T>(delayMs = 400) {
  const [activeItem, setActiveItem] = useState<HoverAnchor<T> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleMouseEnter = useCallback(
    (item: T, element: HTMLElement) => {
      clearTimer();
      timerRef.current = setTimeout(() => {
        setActiveItem({ item, rect: element.getBoundingClientRect() });
      }, delayMs);
    },
    [clearTimer, delayMs],
  );

  const handleMouseLeave = useCallback(() => {
    clearTimer();
    setActiveItem(null);
  }, [clearTimer]);

  const handleScroll = useCallback(() => {
    clearTimer();
    setActiveItem(null);
  }, [clearTimer]);

  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  return {
    activeItem,
    handleMouseEnter,
    handleMouseLeave,
    handleScroll,
  };
}
