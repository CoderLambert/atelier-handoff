/**
 * @file 提供工作台会话快速搜索和切换浮层。
 * @implementation 复用 bootstrap 会话与项目数据，按最近更新排序并在对话框释放焦点后导航。
 * @updated 2026-11-26T20:00:00+08:00
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Check, MessageSquare, Search } from 'lucide-react';
import type { Project, Session } from '@shared/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUiTranslation } from '@/i18n';
import { sessionSwitchItems } from './session-switcher-model';
import './workspace-shortcuts.css';

export function WorkspaceSessionSwitcher({
  open,
  onOpenChange,
  sessions,
  projects,
  current,
  loading,
  failed,
  onRetry,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: readonly Session[];
  projects: readonly Project[];
  current?: string;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useUiTranslation('shortcuts');
  const id = useId();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const selection = useRef<string | undefined>(undefined);
  const origin = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const composingUntil = useRef(0);
  const composing = useRef(false);
  const items = sessionSwitchItems(sessions, projects, query).slice(0, 100);
  const index = Math.min(selected, Math.max(0, items.length - 1));
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    selection.current = undefined;
    composing.current = false;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, index, open, query]);
  function select(sessionId: string) {
    selection.current = sessionId;
    onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="workspace-session-switcher"
        data-shortcut-surface="switcher"
        onEscapeKeyDown={(event) => {
          if (
            composing.current ||
            event.isComposing ||
            event.keyCode === 229 ||
            performance.now() < composingUntil.current
          )
            event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          origin.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          input.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const next = selection.current;
          event.preventDefault();
          if (!next) {
            if (origin.current?.isConnected) origin.current.focus({ preventScroll: true });
            return;
          }
          selection.current = undefined;
          requestAnimationFrame(() => onSelect(next));
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('switcherTitle')}</DialogTitle>
          <DialogDescription>{t('switcherDescription')}</DialogDescription>
        </DialogHeader>
        <div className="workspace-switcher-search">
          <Search aria-hidden="true" />
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-label={t('switcherPlaceholder')}
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={items.length ? `${id}-${index}` : undefined}
            placeholder={t('switcherPlaceholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
              composingUntil.current = performance.now() + 80;
            }}
            onKeyDown={(event) => {
              if (
                composing.current ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229 ||
                performance.now() < composingUntil.current
              )
                return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected(
                  items.length
                    ? (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                    : 0,
                );
              } else if (event.key === 'Enter' && !event.repeat) {
                event.preventDefault();
                const item = items[index];
                if (item) select(item.session.id);
              }
            }}
          />
        </div>
        {loading ? (
          <p className="workspace-switcher-status" role="status">
            {t('switcherLoading')}
          </p>
        ) : null}
        {failed ? (
          <div className="workspace-switcher-status">
            <p role="alert">{t('switcherFailed')}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t('retry')}
            </Button>
          </div>
        ) : null}
        {!loading && !failed && !items.length ? (
          <p className="workspace-switcher-status" role="status">
            {t('switcherEmpty')}
          </p>
        ) : null}
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={t('switcherTitle')}
          className="workspace-switcher-list"
        >
          {items.map(({ session, projectName }, itemIndex) => (
            <Button
              variant="ghost"
              role="option"
              id={`${id}-${itemIndex}`}
              key={session.id}
              aria-selected={itemIndex === index}
              tabIndex={-1}
              title={session.title}
              className="workspace-switcher-item"
              onPointerMove={() => setSelected(itemIndex)}
              onClick={() => select(session.id)}
            >
              <MessageSquare data-icon="inline-start" aria-hidden="true" />
              <span className="workspace-switcher-copy">
                <strong className="truncate">{session.title}</strong>
                <span className="truncate" title={projectName}>
                  {projectName}
                </span>
              </span>
              {session.status === 'archived' ? (
                <span className="workspace-switcher-meta">{t('archived')}</span>
              ) : null}
              {session.id === current ? (
                <Check data-icon="inline-end" aria-label={t('current')} />
              ) : null}
            </Button>
          ))}
        </div>
        <p className="workspace-switcher-footer">{t('switcherHint')}</p>
      </DialogContent>
    </Dialog>
  );
}
