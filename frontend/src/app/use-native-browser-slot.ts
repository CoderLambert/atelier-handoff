/**
 * @file 监听桌面浏览器宿主槽位几何坐标与弹层遮挡并通知主进程更新原生视图边界。
 * @implementation 复用 ResizeObserver、局部弹层变化过滤与坐标浅比较去重，避免无关 DOM 变动触发重排和无效 IPC。
 * @updated 2026-11-27T22:00:00+08:00
 */
import { useEffect, type RefObject } from 'react';
import { workspaceLayoutEvent } from './workspace-panels';
import type { DesktopBrowserLayout } from '@shared/desktop-browser';

export type BrowserBounds = DesktopBrowserLayout['bounds'];

const dialogSelector = '[role="dialog"]';

export function boundsEqual(previous: BrowserBounds | undefined, next: BrowserBounds): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return (
    previous.x === next.x &&
    previous.y === next.y &&
    previous.width === next.width &&
    previous.height === next.height
  );
}

export function observeNativeBrowserSlot(
  slot: HTMLDivElement,
  send: (bounds: BrowserBounds) => void,
): () => void {
  let lastBounds: BrowserBounds | undefined;
  let frame: number | undefined;
  let dialogs = new Set<Element>();

  function publish(bounds: BrowserBounds) {
    if (boundsEqual(lastBounds, bounds)) return;
    lastBounds = bounds;
    send(bounds);
  }

  function schedule() {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (
        document.hidden ||
        [...dialogs].some((dialog) => dialog.getBoundingClientRect().width > 0)
      ) {
        publish(null);
        return;
      }
      const { x, y, width, height } = slot.getBoundingClientRect();
      publish(width > 0 && height > 0 ? { x, y, width, height } : null);
    });
  }

  const sizes = new ResizeObserver(schedule);
  sizes.observe(slot);
  if (slot.parentElement) sizes.observe(slot.parentElement);

  function updateDialogs() {
    const next = new Set(
      [...document.querySelectorAll(dialogSelector)].filter((dialog) => !dialog.contains(slot)),
    );
    for (const dialog of dialogs) if (!next.has(dialog)) sizes.unobserve(dialog);
    for (const dialog of next) if (!dialogs.has(dialog)) sizes.observe(dialog);
    dialogs = next;
    schedule();
  }

  function containsDialog(node: Node) {
    return (
      node instanceof Element &&
      (node.matches(dialogSelector) || Boolean(node.querySelector(dialogSelector)))
    );
  }

  const mutations = new MutationObserver((records) => {
    const dialogChanged = records.some((record) =>
      record.type === 'childList'
        ? [...record.addedNodes, ...record.removedNodes].some(containsDialog)
        : record.target instanceof Element &&
          (record.target.matches(dialogSelector) ||
            (record.attributeName === 'role' && record.oldValue === 'dialog')),
    );
    if (dialogChanged) updateDialogs();
  });

  mutations.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['role', 'data-state'],
    attributeOldValue: true,
  });

  function onScroll(event: Event) {
    const target = event.target;
    if (target === window || (target instanceof Node && target.contains(slot))) schedule();
  }

  function onVisibilityChange() {
    if (document.hidden) publish(null);
    else schedule();
  }

  window.addEventListener(workspaceLayoutEvent, schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', onScroll, true);
  document.addEventListener('visibilitychange', onVisibilityChange);
  updateDialogs();

  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    sizes.disconnect();
    mutations.disconnect();
    window.removeEventListener(workspaceLayoutEvent, schedule);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (lastBounds) publish(null);
  };
}

export function useNativeBrowserSlot(
  slotRef: RefObject<HTMLDivElement | null>,
  projectId: string,
  bridge: Pick<NonNullable<Window['atelierDesktop']>, 'layout'> | undefined,
): void {
  useEffect(() => {
    const element = slotRef.current;
    if (!bridge || !element) return;
    return observeNativeBrowserSlot(element, (bounds) => bridge.layout(projectId, bounds));
  }, [bridge, projectId, slotRef]);
}
