/**
 * @file 提供输入区扩展和文件补全。
 * @implementation 跟踪光标和输入法以查询补全候选，同步无障碍选中项，并在选用候选后统一恢复输入焦点与光标。
 * @updated 2026-11-27T17:00:34+08:00
 */
import { useUiTranslation } from '@/i18n';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { AgentSessionInfo, Draft, Extension } from '@shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, File, Folder, X } from 'lucide-react';
import { formatBytes } from '@/utils/format';
import { Button } from '@/components/ui/button';
import { ExtensionKindIcon } from './components';
import {
  extensionPickerKeys,
  invalidateExtensionPickers,
  messageOf,
  pickerCatalogItems,
  useExtensions,
} from './api';
import { useSearchProjectFiles } from '@/use-query/projects/use-search-project-files';
import { skillInheritanceKeys, type SessionSkillScope } from '@/use-query/skill-inheritance/keys';
import { useSkillInheritance } from '@/use-query/skill-inheritance/use-skill-inheritance';
import type { SkillInheritanceView } from '@shared/skill-inheritance';
import { skillSources } from './inheritance-controls';
import {
  allowedTools,
  choices,
  chooseDirectory,
  chooseExtension,
  chooseFile,
  completionSkills,
  selectionReason,
  triggerAt,
} from './picker-model';
import './extensions.css';

export interface ExtensionPickerProps {
  projectId?: string;
  sessionId?: string;
  skillScope: SessionSkillScope;
  sessionSkillIds: ReadonlySet<string>;
  agent?: AgentSessionInfo;
  contextAllowed?: boolean;
  draft: Draft;
  onChange: (draft: Draft) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSubmit: () => void;
  onQuickInsert?: () => void;
}
interface FileCompletionRow {
  path: string;
  name: string;
  dir: string;
  size: number;
  label: string;
  isDirectory: boolean;
}
function highlightMatch(text: string, query: string) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="ext-file-match">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
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
  sessionId,
  skillScope,
  sessionSkillIds,
  agent,
  contextAllowed = true,
  draft,
  onChange,
  inputRef,
  onSubmit,
  onQuickInsert,
}: ExtensionPickerProps) {
  const { t } = useUiTranslation('extensions');
  const query = useExtensions(projectId, 'picker');
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
  const catalog = client.getQueryState<Extension[]>(extensionPickerKeys.list(projectId ?? ''));
  const pickerLoading = query.isPending || (query.isFetching && Boolean(catalog?.isInvalidated));
  const items = scopeExtensions(pickerCatalogItems(projectId, query.data, catalog), agent);
  const trigger = triggerAt(cursor.text, cursor.start, cursor.end);
  const completionKey = JSON.stringify([
    projectId,
    skillScope.sessionId,
    skillScope.mode,
    cursor.text,
    cursor.start,
    cursor.end,
  ]);
  const active = Boolean(
    projectId && cursor.focused && !cursor.disabled && !composing && dismissed !== completionKey,
  );
  const isSlash = trigger?.symbol === '/';
  const preview = useSkillInheritance(skillScope, active && isSlash);
  const skillItems =
    isSlash && preview.isSuccess && !preview.isFetching ? completionSkills(preview.data.items) : [];
  const rows =
    !trigger || trigger.symbol === '@'
      ? []
      : choices(
          isSlash ? [...items.filter(({ kind }) => kind === 'command'), ...skillItems] : items,
          trigger,
          cursor.text,
          draft.mode,
        );

  const fileSearch = useSearchProjectFiles(
    projectId,
    trigger?.symbol === '@' ? trigger.query : '',
    Boolean(projectId && trigger?.symbol === '@' && contextAllowed),
    sessionId,
  );
  const fileRows: FileCompletionRow[] = useMemo(() => {
    if (trigger?.symbol !== '@' || !fileSearch.data?.items) return [];
    return fileSearch.data.items.map((file) => {
      const lastSlash = file.path.lastIndexOf('/');
      const dir = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : '';
      const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;
      return {
        path: file.path,
        name,
        dir,
        size: file.size,
        label: file.isDirectory ? `@${file.path}/` : `@${file.path}`,
        isDirectory: file.isDirectory,
      };
    });
  }, [trigger?.symbol, fileSearch.data]);

  const isFile = trigger?.symbol === '@';
  const activeCount = isFile ? fileRows.length : rows.length;
  const selectedIndex = Math.min(index, Math.max(0, activeCount - 1));
  const previewError = isSlash && preview.isError;
  const previewLoading = isSlash && (preview.isPending || preview.isFetching);
  const open = Boolean(
    active &&
    trigger &&
    (isFile
      ? contextAllowed &&
        (fileRows.length || !trigger.query || fileSearch.isPending || fileSearch.isError)
      : rows.length ||
        !trigger.query ||
        pickerLoading ||
        query.isError ||
        previewError ||
        previewLoading),
  );
  const current = useRef({
    projectId,
    skillScope,
    agent,
    draft,
    onChange,
    onSubmit,
    onQuickInsert,
    open,
    rows,
    fileRows,
    selectedIndex,
    trigger,
    completionKey,
  });
  current.current = {
    projectId,
    skillScope,
    agent,
    draft,
    onChange,
    onSubmit,
    onQuickInsert,
    open,
    rows,
    fileRows,
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
    if (
      !input ||
      !state.projectId ||
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
    const applyChoice = ({ draft, caret }: { draft: Draft; caret: number }, directory = false) => {
      const scope = state.projectId;
      // Preserve the caret for the controlled host input before React applies the draft.
      input.value = draft.text;
      input.setSelectionRange(caret, caret);
      if (directory) setIndex(0);
      else setDismissed(JSON.stringify([scope, draft.text, caret, caret]));
      state.onChange(draft);
      sync();
      if (selectionFrame.current) cancelAnimationFrame(selectionFrame.current);
      selectionFrame.current = requestAnimationFrame(() => {
        if (
          current.current.projectId !== scope ||
          inputRef.current !== input ||
          !input.isConnected ||
          current.current.draft.text !== draft.text
        )
          return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(caret, caret);
        sync();
      });
    };
    if (token.symbol === '@') {
      const fileRow = state.fileRows[choiceIndex];
      if (!fileRow) {
        sync();
        return;
      }
      if (fileRow.isDirectory) applyChoice(chooseDirectory(state.draft, token, fileRow), true);
      else applyChoice(chooseFile(state.draft, token, fileRow));
      return;
    }
    const row = state.rows[choiceIndex];
    if (!row) return;
    const latest = (() => {
      if ('effective' in row.item) {
        const cached = client.getQueryState<SkillInheritanceView>(
          skillInheritanceKeys.view(state.skillScope),
        );
        if (cached?.status !== 'success' || cached.fetchStatus !== 'idle' || cached.isInvalidated)
          return;
        return completionSkills(cached.data?.items ?? []).find(({ id }) => id === row.item.id);
      }
      const cached = client.getQueryState<Extension[]>(extensionPickerKeys.list(state.projectId));
      return scopeExtensions(
        pickerCatalogItems(state.projectId, cached?.data, cached),
        state.agent,
      ).find((item) => item.id === row.item.id);
    })();
    if (
      !latest ||
      latest.version !== row.item.version ||
      (!('effective' in latest) &&
        (!latest.enabled || (latest.kind !== 'mcp' && !latest.supported)))
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
    applyChoice(
      chooseExtension({ ...state.draft, text: input.value }, token, { ...row, item: latest }),
    );
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
    const state = current.current;
    if (
      event.key === 'Enter' &&
      event.altKey !== event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !inputRef.current?.disabled &&
      !inputRef.current?.readOnly &&
      state.onQuickInsert
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) state.onQuickInsert();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const activeLength = state.trigger?.symbol === '@' ? state.fileRows.length : state.rows.length;
    if (state.open && activeLength && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setIndex(
        (state.selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + activeLength) % activeLength,
      );
    } else if (state.open && activeLength && ['Enter', 'Tab'].includes(event.key)) {
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
    if (open && activeCount)
      input.setAttribute('aria-activedescendant', `${id}-option-${selectedIndex}`);
    else input.removeAttribute('aria-activedescendant');
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-option-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [inputRef, id, open, activeCount, selectedIndex]);
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
  const pickerSelections = draft.extensionSelections?.filter(({ id }) => !sessionSkillIds.has(id));
  return (
    <>
      {pickerSelections?.length ? (
        <div className="ext-chips" aria-label={t('picker.selectedLabel')}>
          {pickerSelections.map((selection) => {
            const item = byId.get(selection.id);
            const reason =
              selection.tools || item?.kind === 'mcp'
                ? selectionReason(item, selection, draft.mode, query.data !== undefined)
                : preview.isSuccess && !preview.isFetching
                  ? t('picker.unavailable')
                  : '';
            return (
              <span
                key={selection.id}
                className={`ext-chip ${reason ? 'ext-chip-unavailable' : ''}`}
                title={
                  reason ||
                  (item?.kind === 'skill'
                    ? t('picker.skillHint')
                    : selection.tools?.join(', ') || item?.description)
                }
              >
                <span aria-hidden="true">
                  <ExtensionKindIcon kind={item?.kind} />
                </span>
                <span>
                  {item?.name || selection.id}
                  {selection.tools?.length
                    ? t('picker.toolsCount', { count: selection.tools.length })
                    : ''}
                  {reason ? <small>{reason}</small> : null}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('picker.removeLabel', { name: item?.name || selection.id })}
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
                  <X data-icon="inline-start" aria-hidden="true" />
                </Button>
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
                <strong>
                  {trigger?.symbol === '@'
                    ? t('picker.filesHeading')
                    : trigger?.symbol === '/'
                      ? t('picker.heading')
                      : t('common.mcpTools')}
                </strong>
                <span>
                  {trigger?.symbol === '#' && !agent
                    ? t('picker.mcpScope')
                    : t('common.currentProject')}
                </span>
              </div>
              <div
                id={`${id}-list`}
                className="ext-completion-list"
                role="listbox"
                aria-label={
                  trigger?.symbol === '@'
                    ? t('picker.chooseFile')
                    : trigger?.symbol === '/'
                      ? t('picker.chooseCommand')
                      : t('picker.chooseMcp')
                }
              >
                {isFile ? (
                  fileRows.length ? (
                    fileRows.map((file, rowIndex) => {
                      const queryLastSlash = trigger.query.lastIndexOf('/');
                      const nameQuery =
                        queryLastSlash >= 0
                          ? trigger.query.slice(queryLastSlash + 1)
                          : trigger.query;
                      return (
                        <button
                          key={`${file.isDirectory ? 'dir' : 'file'}:${file.path}`}
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
                            {file.isDirectory ? (
                              <Folder className="size-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <File className="size-4 shrink-0 text-muted-foreground" />
                            )}
                          </span>
                          <span className="ext-option-copy">
                            <strong className="ext-file-name">
                              {highlightMatch(file.name + (file.isDirectory ? '/' : ''), nameQuery)}
                            </strong>
                            {file.dir ? (
                              <small className="ext-file-dir">
                                {highlightMatch(file.dir, nameQuery || trigger.query)}
                              </small>
                            ) : null}
                          </span>
                          <span className="ext-option-kind">
                            {file.isDirectory ? (
                              <ChevronRight
                                className="size-3.5 text-muted-foreground"
                                aria-hidden="true"
                              />
                            ) : file.size > 0 ? (
                              <span className="ext-file-size">{formatBytes(file.size)}</span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })
                  ) : (
                    <div className="ext-completion-empty" role="status">
                      {fileSearch.isError ? (
                        <>
                          {messageOf(fileSearch.error)}{' '}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void fileSearch.refetch()}
                          >
                            {t('common.reload')}
                          </Button>
                        </>
                      ) : fileSearch.isPending ? (
                        t('extensions.loading')
                      ) : (
                        t('picker.noFiles')
                      )}
                    </div>
                  )
                ) : rows.length ? (
                  rows.map((row, rowIndex) => (
                    <button
                      key={`${row.skillSource ?? row.item.kind}:${row.item.id}:${row.label}`}
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
                        <ExtensionKindIcon kind={row.item.kind} />
                      </span>
                      <span className="ext-option-copy">
                        <strong>{row.label}</strong>
                        <small>
                          {row.skillSource ? t(skillSources[row.skillSource]) : null}
                          {row.skillSource && row.description ? ' · ' : null}
                          {row.description || (!row.skillSource && row.kind)}
                        </small>
                      </span>
                      {row.skillSource ? null : (
                        <span className="ext-option-kind">
                          {row.item.kind === 'mcp' && row.item.projectId !== projectId
                            ? t('picker.sharedApproval')
                            : row.kind}
                        </span>
                      )}
                    </button>
                  ))
                ) : null}
                {!isFile && (previewError || (isSlash && query.isError)) ? (
                  <div className="ext-completion-empty" role="status">
                    {previewError ? t('inheritance.loadFailed') : messageOf(query.error)}{' '}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (previewError) void preview.refetch();
                        if (query.isError) void invalidateExtensionPickers(client);
                      }}
                    >
                      {t('common.reload')}
                    </Button>
                  </div>
                ) : !isFile && !rows.length ? (
                  <div className="ext-completion-empty" role="status">
                    {query.isError ? (
                      <>
                        {messageOf(query.error)}{' '}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void invalidateExtensionPickers(client)}
                        >
                          {t('common.reload')}
                        </Button>
                      </>
                    ) : previewLoading || pickerLoading ? (
                      t('extensions.loading')
                    ) : trigger?.symbol === '#' ? (
                      t('picker.noTools')
                    ) : (
                      t('picker.noCommands')
                    )}
                  </div>
                ) : null}
              </div>
              <div className="ext-completion-footer">
                <span>{t('picker.selectHint')}</span>
                <span>{t('picker.confirmHint')}</span>
                <span>{t('picker.closeHint')}</span>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
