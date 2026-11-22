/**
 * @file 提供助手正文选区旁的引用操作。
 * @implementation 从同一条消息读取文本选区，拖选结束后定位按钮，并向输入区传递文字快照。
 * @updated 2026-11-23T01:10:00+08:00
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Quote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';

export type QuoteSelectionAction = (messageId: string, text: string) => boolean;

type SelectionQuotePosition = {
  messageId: string;
  text: string;
  x: number;
  y: number;
  above: boolean;
};

function selectedBody(node: Node | null): Element | null | undefined {
  return (node instanceof Element ? node : node?.parentElement)?.closest('.chat-markdown');
}

function selectedQuote(viewport: HTMLElement): SelectionQuotePosition | undefined {
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

export function SelectionQuote({
  viewport,
  onQuote,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  onQuote: QuoteSelectionAction;
}) {
  const { t } = useUiTranslation('chat');
  const button = useRef<HTMLButtonElement>(null);
  const [quote, setQuote] = useState<SelectionQuotePosition>();

  useEffect(() => {
    if (!viewport.current) return;
    const root: HTMLDivElement = viewport.current;
    const controller = new AbortController();
    const listen = { signal: controller.signal };
    const capture = { ...listen, capture: true };
    let dragging = false;
    let dismissed = false;
    let frame = 0;

    function dismiss() {
      dismissed = true;
      cancelAnimationFrame(frame);
      frame = 0;
      setQuote(undefined);
    }

    function schedule() {
      if (dragging || dismissed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = selectedQuote(root);
        if (
          !next &&
          button.current &&
          document.activeElement === button.current &&
          window.getSelection()?.isCollapsed
        )
          return;
        setQuote(next);
      });
    }

    function selectionChanged() {
      dismissed = false;
      schedule();
    }

    function pointerDown(event: PointerEvent) {
      if (
        !event.isPrimary ||
        (event.target instanceof Node && button.current?.contains(event.target))
      )
        return;
      const body = event.target instanceof Node ? selectedBody(event.target) : undefined;
      dragging = event.button === 0 && Boolean(body && root.contains(body));
      dismiss();
    }

    function pointerUp(event: PointerEvent) {
      if (!event.isPrimary || !dragging) return;
      dragging = false;
      selectionChanged();
    }

    function cancelSelection() {
      dragging = false;
      dismiss();
    }

    function keyDown(event: KeyboardEvent) {
      const trigger = button.current;
      if (
        !trigger ||
        event.defaultPrevented ||
        event.isComposing ||
        document.activeElement?.closest('[role="dialog"]')
      )
        return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (document.activeElement === trigger) root.focus({ preventScroll: true });
        dismiss();
      } else if (
        event.altKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.code === 'KeyQ'
      ) {
        event.preventDefault();
        if (!event.repeat) trigger.click();
      }
    }

    document.addEventListener('selectionchange', selectionChanged, listen);
    document.addEventListener('pointerdown', pointerDown, capture);
    document.addEventListener('pointerup', pointerUp, capture);
    document.addEventListener('pointercancel', cancelSelection, capture);
    document.addEventListener('keydown', keyDown, listen);
    document.addEventListener('focusin', schedule, listen);
    root.addEventListener('scroll', schedule, capture);
    window.addEventListener('resize', schedule, listen);
    window.addEventListener('blur', cancelSelection, listen);
    schedule();
    return () => {
      controller.abort();
      cancelAnimationFrame(frame);
    };
  }, [viewport]);

  return quote ? (
    <Button
      ref={button}
      type="button"
      variant="outline"
      size="sm"
      className="selection-quote-action"
      data-placement={quote.above ? 'above' : 'below'}
      style={{ left: quote.x, top: quote.y }}
      aria-keyshortcuts="Alt+Shift+Q"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!onQuote(quote.messageId, quote.text)) return;
        window.getSelection()?.removeAllRanges();
        setQuote(undefined);
      }}
    >
      <Quote data-icon="inline-start" aria-hidden="true" />
      {t('message.quoteSelection')}
    </Button>
  ) : null;
}
