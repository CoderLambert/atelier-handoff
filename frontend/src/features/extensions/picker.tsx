import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { AgentSessionInfo, Draft, Extension } from '@shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { extensionKeys, marks, messageOf, useExtensions } from './api';
import { allowedTools, choices, chooseExtension, selectionReason, triggerAt } from './picker-model';
import './extensions.css';

export interface ExtensionPickerProps {
  projectId?: string;
  agent?: AgentSessionInfo;
  draft: Draft;
  onChange: (draft: Draft) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSubmit: () => void;
}
interface Cursor {
  text: string;
  start: number;
  end: number;
  focused: boolean;
  disabled: boolean;
}
const emptyCursor: Cursor = { text: '', start: 0, end: 0, focused: false, disabled: false };
function scopeExtensions(items: Extension[], agent?: AgentSessionInfo): Extension[] {
  if (!agent) return items;
  return items.flatMap((item): Extension[] => {
    if (
      item.kind === 'skill' &&
      agent.skills.some((ref) => ref.id === item.id && ref.version === item.version)
    )
      return [item];
    if (item.kind !== 'mcp') return [];
    const ref = agent.mcp.find((ref) => ref.id === item.id && ref.version === item.version);
    return ref
      ? [
          {
            ...item,
            allowedTools: item.allowedTools.filter((tool) => ref.tools.includes(tool.name)),
          },
        ]
      : [];
  });
}

export function ExtensionPicker({
  projectId,
  agent,
  draft,
  onChange,
  inputRef,
  onSubmit,
}: ExtensionPickerProps) {
  const query = useExtensions(projectId);
  const client = useQueryClient();
  const id = useId();
  const [cursor, setCursor] = useState(emptyCursor);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const [composing, setComposing] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const composition = useRef({ active: false, until: 0 });
  const binding = useRef<{ input: HTMLTextAreaElement; cleanup: () => void } | undefined>(
    undefined,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const selectionFrame = useRef<number | undefined>(undefined);
  const lastScope = useRef(projectId);
  const items = scopeExtensions(query.data ?? [], agent);
  const trigger = triggerAt(cursor.text, cursor.start, cursor.end);
  const completionKey = JSON.stringify([projectId, cursor.text, cursor.start, cursor.end]);
  const rows = trigger ? choices(items, trigger, cursor.text, draft.mode) : [];
  const selectedIndex = Math.min(index, Math.max(0, rows.length - 1));
  const open = Boolean(
    projectId &&
    cursor.focused &&
    !cursor.disabled &&
    !composing &&
    trigger &&
    dismissed !== completionKey &&
    (rows.length || !trigger.query || query.isPending || query.isError),
  );
  const current = useRef({
    projectId,
    agent,
    draft,
    onChange,
    onSubmit,
    open,
    rows,
    selectedIndex,
    trigger,
    completionKey,
  });
  current.current = {
    projectId,
    agent,
    draft,
    onChange,
    onSubmit,
    open,
    rows,
    selectedIndex,
    trigger,
    completionKey,
  };

  function sync() {
    const input = inputRef.current;
    if (!input) return;
    const next: Cursor = {
      text: input.value,
      start: input.selectionStart,
      end: input.selectionEnd,
      focused: document.activeElement === input,
      disabled: input.disabled || input.readOnly,
    };
    setCursor((old) =>
      old.text === next.text &&
      old.start === next.start &&
      old.end === next.end &&
      old.focused === next.focused &&
      old.disabled === next.disabled
        ? old
        : next,
    );
  }
  function hide() {
    setDismissed(current.current.completionKey);
  }
  function choose(choiceIndex: number) {
    const state = current.current;
    const input = inputRef.current;
    const row = state.rows[choiceIndex];
    if (
      !input ||
      !state.projectId ||
      !row ||
      input.disabled ||
      input.readOnly ||
      composition.current.active
    )
      return;
    const token = triggerAt(input.value, input.selectionStart, input.selectionEnd);
    if (!token || token.start !== state.trigger?.start || token.word !== state.trigger.word) {
      sync();
      return;
    }
    const latest = scopeExtensions(
      client.getQueryData<Extension[]>(extensionKeys.list(state.projectId)) ?? [],
      state.agent,
    ).find((item) => item.id === row.item.id);
    if (
      !latest ||
      !latest.enabled ||
      latest.version !== row.item.version ||
      (latest.kind !== 'mcp' && !latest.supported) ||
      (latest.kind === 'skill' && latest.userInvocable === false)
    ) {
      sync();
      return;
    }
    if (latest.kind === 'mcp') {
      const allowed = new Set(allowedTools(latest, state.draft.mode).map((tool) => tool.name));
      if (!row.tools?.length || row.tools.some((tool) => !allowed.has(tool))) {
        sync();
        return;
      }
    }
    const result = chooseExtension({ ...state.draft, text: input.value }, token, {
      ...row,
      item: latest,
    });
    const scope = state.projectId;
    // Updating the textarea now also preserves the caret for a controlled host input.
    input.value = result.draft.text;
    input.setSelectionRange(result.caret, result.caret);
    setDismissed(JSON.stringify([scope, result.draft.text, result.caret, result.caret]));
    state.onChange(result.draft);
    sync();
    if (selectionFrame.current) cancelAnimationFrame(selectionFrame.current);
    selectionFrame.current = requestAnimationFrame(() => {
      if (
        current.current.projectId !== scope ||
        inputRef.current !== input ||
        !input.isConnected ||
        current.current.draft.text !== result.draft.text
      )
        return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(result.caret, result.caret);
      sync();
    });
  }
  function keydown(event: KeyboardEvent) {
    if (
      composition.current.active ||
      event.isComposing ||
      event.keyCode === 229 ||
      Date.now() < composition.current.until
    ) {
      if (event.key === 'Enter') event.stopImmediatePropagation();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const state = current.current;
    if (state.open && state.rows.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setIndex(
        (state.selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + state.rows.length) %
          state.rows.length,
      );
    } else if (state.open && state.rows.length && ['Enter', 'Tab'].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      choose(state.selectedIndex);
    } else if (state.open && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      hide();
    } else if (
      event.key === 'Enter' &&
      !inputRef.current?.disabled &&
      !inputRef.current?.readOnly
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      state.onSubmit();
    }
  }
  const handlers = useRef({ sync, keydown });
  handlers.current = { sync, keydown };
  // A host may replace the textarea on session navigation while retaining its ref.
  // Bind once per actual node and keep listeners current through refs.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (binding.current?.input !== input) {
      binding.current?.cleanup();
      binding.current = undefined;
      if (input) {
        const attributes = [
          'aria-autocomplete',
          'aria-haspopup',
          'aria-controls',
          'aria-expanded',
          'aria-activedescendant',
        ];
        const previous = new Map(attributes.map((name) => [name, input.getAttribute(name)]));
        const onInput = () => {
          setDismissed('');
          setIndex(0);
          handlers.current.sync();
        };
        const onSync = () => handlers.current.sync();
        const onKeyDown = (event: KeyboardEvent) => handlers.current.keydown(event);
        const onKeyUp = (event: KeyboardEvent) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
            handlers.current.sync();
        };
        const onCompositionStart = () => {
          composition.current.active = true;
          setComposing(true);
        };
        const onCompositionEnd = () => {
          composition.current.active = false;
          composition.current.until = Date.now() + 50;
          setComposing(false);
          setDismissed('');
          handlers.current.sync();
        };
        input.addEventListener('input', onInput);
        input.addEventListener('focus', onSync);
        input.addEventListener('blur', onSync);
        input.addEventListener('click', onSync);
        input.addEventListener('select', onSync);
        input.addEventListener('keyup', onKeyUp);
        input.addEventListener('keydown', onKeyDown, true);
        input.addEventListener('compositionstart', onCompositionStart);
        input.addEventListener('compositionend', onCompositionEnd);
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-haspopup', 'listbox');
        binding.current = {
          input,
          cleanup: () => {
            input.removeEventListener('input', onInput);
            input.removeEventListener('focus', onSync);
            input.removeEventListener('blur', onSync);
            input.removeEventListener('click', onSync);
            input.removeEventListener('select', onSync);
            input.removeEventListener('keyup', onKeyUp);
            input.removeEventListener('keydown', onKeyDown, true);
            input.removeEventListener('compositionstart', onCompositionStart);
            input.removeEventListener('compositionend', onCompositionEnd);
            for (const [name, value] of previous) {
              if (value == null) input.removeAttribute(name);
              else input.setAttribute(name, value);
            }
          },
        };
      }
    }
    if (lastScope.current !== projectId) {
      lastScope.current = projectId;
      setDismissed('');
      setIndex(0);
      composition.current.active = false;
      setComposing(false);
    }
    handlers.current.sync();
  });
  useEffect(
    () => () => {
      binding.current?.cleanup();
      binding.current = undefined;
      if (selectionFrame.current) cancelAnimationFrame(selectionFrame.current);
    },
    [],
  );
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.setAttribute('aria-expanded', String(open));
    if (open) input.setAttribute('aria-controls', `${id}-list`);
    else input.removeAttribute('aria-controls');
    if (open && rows.length)
      input.setAttribute('aria-activedescendant', `${id}-option-${selectedIndex}`);
    else input.removeAttribute('aria-activedescendant');
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-option-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [inputRef, id, open, rows.length, selectedIndex]);
  useLayoutEffect(() => {
    if (!open) return;
    function positionMenu() {
      const input = inputRef.current;
      if (!input) return;
      const rect = input.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const menuWidth = Math.max(0, Math.min(Math.max(rect.width, 320), 520, width - 32));
      const above = rect.top - topEdge - 16;
      const below = topEdge + height - rect.bottom - 16;
      const openAbove = above >= Math.min(280, below);
      const maxHeight = Math.max(100, Math.min(380, openAbove ? above : below));
      setPosition({
        width: menuWidth,
        left: Math.max(leftEdge + 16, Math.min(rect.left, leftEdge + width - menuWidth - 16)),
        maxHeight,
        top: openAbove ? 'auto' : rect.bottom + 8,
        bottom: openAbove ? window.innerHeight - rect.top + 8 : 'auto',
      });
    }
    positionMenu();
    window.addEventListener('resize', positionMenu, { passive: true });
    window.addEventListener('scroll', positionMenu, { capture: true, passive: true });
    window.visualViewport?.addEventListener('resize', positionMenu, { passive: true });
    window.visualViewport?.addEventListener('scroll', positionMenu, { passive: true });
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(positionMenu) : undefined;
    if (inputRef.current) observer?.observe(inputRef.current);
    return () => {
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
      window.visualViewport?.removeEventListener('resize', positionMenu);
      window.visualViewport?.removeEventListener('scroll', positionMenu);
      observer?.disconnect();
    };
  }, [open, inputRef]);
  const byId = new Map(items.map((item) => [item.id, item]));
  return (
    <>
      {(draft.extensionSelections?.length ?? 0) > 0 ? (
        <div className="ext-chips" aria-label="已选择的扩展">
          {draft.extensionSelections?.map((selection) => {
            const item = byId.get(selection.id);
            const reason = selectionReason(item, selection, draft.mode, query.data !== undefined);
            return (
              <span
                key={selection.id}
                className={`ext-chip ${reason ? 'ext-chip-unavailable' : ''}`}
                title={reason || selection.tools?.join(', ') || item?.description}
              >
                <span aria-hidden="true">{item ? marks[item.kind] : '+'}</span>
                <span>
                  {item?.name || selection.id}
                  {selection.tools?.length ? ` · ${selection.tools.length} 个工具` : ''}
                  {reason ? <small>{reason}</small> : null}
                </span>
                <button
                  type="button"
                  aria-label={`移除 ${item?.name || selection.id}`}
                  onClick={() => {
                    onChange({
                      ...draft,
                      extensionSelections: draft.extensionSelections?.filter(
                        (value) => value.id !== selection.id,
                      ),
                    });
                    inputRef.current?.focus({ preventScroll: true });
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              className="ext-completion"
              style={position}
              onPointerDown={(event) => {
                if (event.button === 0) event.preventDefault();
              }}
            >
              <div className="ext-completion-head">
                <strong>{trigger?.symbol === '/' ? 'Commands & Skills' : 'MCP 工具'}</strong>
                <span>当前项目</span>
              </div>
              <div
                id={`${id}-list`}
                className="ext-completion-list"
                role="listbox"
                aria-label={trigger?.symbol === '/' ? '选择命令或 Skill' : '选择 MCP 工具'}
              >
                {rows.length ? (
                  rows.map((row, rowIndex) => (
                    <button
                      key={`${row.item.id}:${row.label}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      id={`${id}-option-${rowIndex}`}
                      data-option-index={rowIndex}
                      aria-selected={selectedIndex === rowIndex}
                      onPointerMove={() => setIndex(rowIndex)}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        choose(rowIndex);
                      }}
                    >
                      <span className="ext-option-mark" aria-hidden="true">
                        {marks[row.item.kind]}
                      </span>
                      <span className="ext-option-copy">
                        <strong>{row.label}</strong>
                        <small>{row.description || row.kind}</small>
                      </span>
                      <span className="ext-option-kind">{row.kind}</span>
                    </button>
                  ))
                ) : (
                  <div className="ext-completion-empty" role="status">
                    {query.isError ? (
                      <>
                        {messageOf(query.error)}{' '}
                        <button type="button" onClick={() => void query.refetch()}>
                          重新加载
                        </button>
                      </>
                    ) : query.isPending ? (
                      '正在读取项目扩展…'
                    ) : trigger?.symbol === '#' ? (
                      '没有可用工具。请先测试 MCP 并允许工具。'
                    ) : (
                      '此项目暂无已启用的命令或可手动调用的 Skill。'
                    )}
                  </div>
                )}
              </div>
              <div className="ext-completion-footer">
                <span>↑ ↓ 选择</span>
                <span>Enter / Tab 确认</span>
                <span>Esc 关闭</span>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
