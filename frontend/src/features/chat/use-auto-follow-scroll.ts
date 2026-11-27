/**
 * @file 管理对话滚动跟随和新消息提示。
 * @implementation 观察实际视口和消息高度，标记过的展开交互会暂停自动跟随。
 * @updated 2026-11-27T19:30:00+08:00
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { Snapshot } from '@/api/types';

export function useAutoFollowScroll({
  messages,
  runs,
  tools,
  subagents,
  artifacts,
  permissions,
}: Pick<Snapshot, 'messages' | 'runs' | 'tools' | 'subagents' | 'artifacts' | 'permissions'>) {
  const viewport = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);

  const follow = useCallback(() => {
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  const scrollToBottom = useCallback(() => {
    nearBottom.current = true;
    follow();
    setUnseen(false);
  }, [follow]);

  const handleScroll = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    if (nearBottom.current) setUnseen(false);
  }, []);

  const handleClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('[data-preserve-scroll]')) {
      nearBottom.current = false;
    }
  }, []);

  useLayoutEffect(() => {
    if (!viewport.current) return;
    if (nearBottom.current) follow();
    else setUnseen(true);
  }, [messages, runs, tools, subagents, artifacts, permissions, follow]);

  useEffect(() => {
    const element = viewport.current;
    const content = thread.current;
    if (!element || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) follow();
    });
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, [follow]);

  return { viewport, thread, unseen, scrollToBottom, handleScroll, handleClickCapture };
}
