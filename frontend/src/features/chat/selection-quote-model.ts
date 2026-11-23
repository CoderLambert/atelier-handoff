/**
 * @file 对话消息文本选区计算模型。
 * @implementation 从视口内检测选区边界，计算引用操作按钮的坐标位置与吸附方向。
 * @updated 2026-11-23T18:25:00+08:00
 */
export type QuoteSelectionAction = (messageId: string, text: string) => boolean;

export type SelectionQuotePosition = {
  messageId: string;
  text: string;
  x: number;
  y: number;
  above: boolean;
};

export function selectedBody(node: Node | null): Element | null | undefined {
  return (node instanceof Element ? node : node?.parentElement)?.closest('.chat-markdown');
}

export function selectedQuote(viewport: HTMLElement): SelectionQuotePosition | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const body = selectedBody(selection.anchorNode);
  if (!body || body !== selectedBody(selection.focusNode) || !viewport.contains(body)) return;
  const messageId = body.closest<HTMLElement>('.assistant-message[data-message-id]')?.dataset
    .messageId;
  if (!messageId) return;
  const text = selection.toString();
  if (!text.trim()) return;

  const bounds = viewport.getBoundingClientRect();
  const top = Math.max(bounds.top, 0);
  const bottom = Math.min(bounds.bottom, window.innerHeight);
  const left = Math.max(bounds.left, 0);
  const right = Math.min(bounds.right, window.innerWidth);
  const visibleRects = Array.from(selection.getRangeAt(0).getClientRects()).filter(
    (rect) =>
      rect.width > 0 &&
      rect.bottom > top &&
      rect.top < bottom &&
      rect.right > left &&
      rect.left < right,
  );
  const first = visibleRects[0];
  const last = visibleRects.at(-1);
  if (!first || !last) return;

  const gap = 6;
  const buttonHeight = 32;
  if (bottom - top < buttonHeight) return;
  const above = last.bottom + gap + buttonHeight > bottom;
  const anchor = above ? first : last;
  const y = above ? Math.max(top + buttonHeight, anchor.top - gap) : anchor.bottom + gap;
  const margin = Math.min(76, (right - left) / 2);
  const x = Math.min(right - margin, Math.max(left + margin, (anchor.left + anchor.right) / 2));
  return { messageId, text, x, y, above };
}
