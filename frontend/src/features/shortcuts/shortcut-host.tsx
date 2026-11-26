/**
 * @file 提供不依赖工作台业务的快捷命令分发与导航浮层。
 * @implementation 精确消费可用命令，在模态和输入法边界暂停；同步受限原生命令注册，并在弹层退出后交接业务焦点。
 * @updated 2026-11-26T22:00:00+08:00
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  formatShortcutBinding,
  getNavigationKey,
  getShortcutBinding,
  matchShortcut,
  resolveShortcutBindings,
  shortcutInputFromKeyboardEvent,
  type ShortcutPlatform,
} from '@shared/shortcuts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUiTranslation } from '@/i18n';
import { useShortcutPreferences } from '@/use-query/settings/use-shortcut-preferences';
import { useShortcutCommandLabels, type ShortcutCommand } from './commands';
import {
  createShortcutKeyGuard,
  navigationCommand,
  nextAvailableCommand,
} from './shortcut-interaction';
import './shortcuts.css';

export function shortcutPlatform(): ShortcutPlatform {
  return /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other';
}

function scopeBlocked(allowNavigator = false): boolean {
  if (document.activeElement?.closest('[data-shortcuts-block]')) return true;
  return Array.from(
    document.querySelectorAll(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"], [data-shortcuts-recording="true"]',
    ),
  ).some(
    (element) =>
      !(allowNavigator && element.closest('[data-shortcut-surface="navigator"]')) &&
      element.getClientRects().length > 0,
  );
}

function consume(event: KeyboardEvent) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

export function ShortcutHost({
  commands,
  contextKey = '',
}: {
  commands: ShortcutCommand[];
  contextKey?: string;
}) {
  const { t } = useUiTranslation('shortcuts');
  const labels = useShortcutCommandLabels();
  const preferences = useShortcutPreferences();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [nativeFailed, setNativeFailed] = useState(false);
  const guard = useRef(createShortcutKeyGuard());
  const origin = useRef<HTMLElement | null>(null);
  const pending = useRef<{ id: string; context: string } | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const platform = shortcutPlatform();
  const entries = commands.filter((command) => command.id !== 'shortcuts.navigator');

  function openNavigator() {
    if (open) {
      setOpen(false);
      return;
    }
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pending.current = null;
    setSelected(entries.find((entry) => entry.available)?.id);
    setOpen(true);
  }

  const allCommands: ShortcutCommand[] = [
    {
      id: 'shortcuts.navigator',
      ...labels['shortcuts.navigator'],
      available: true,
      run: openNavigator,
    },
    ...entries,
  ];
  const latest = useRef({
    commands: allCommands,
    entries,
    preferences: preferences.data,
    open,
    selected,
    contextKey,
  });
  useLayoutEffect(() => {
    latest.current = {
      commands: allCommands,
      entries,
      preferences: preferences.data,
      open,
      selected,
      contextKey,
    };
  });

  function execute(id: string) {
    const state = latest.current;
    const command = state.commands.find((entry) => entry.id === id && entry.available);
    if (!command || !state.preferences?.enabled) return;
    if (state.open && id !== 'shortcuts.navigator') {
      pending.current = { id, context: state.contextKey };
      setOpen(false);
    } else command.run();
  }
  const executeRef = useRef(execute);
  useLayoutEffect(() => {
    executeRef.current = execute;
  });

  useEffect(() => {
    if (!preferences.data?.enabled) setOpen(false);
  }, [preferences.data?.enabled]);

  useEffect(() => {
    const keyGuard = guard.current;
    function onKeyDown(event: KeyboardEvent) {
      const input = shortcutInputFromKeyboardEvent(event);
      if (keyGuard.suppresses(input)) {
        consume(event);
        return;
      }
      const state = latest.current;
      if (!keyGuard.accepts(input, performance.now()) || !state.preferences?.enabled) return;
      if (
        (input.key === 'Escape' || input.key === 'Enter') &&
        !input.ctrlKey &&
        !input.metaKey &&
        !input.altKey &&
        !input.shiftKey &&
        event.target instanceof Element &&
        event.target.closest('[data-shortcut-surface="switcher"]')
      ) {
        // The switcher owns the first key. Keep its held repeats from reaching the new focus.
        keyGuard.consume(input.code);
        return;
      }
      if (scopeBlocked(state.open)) return;
      const activePreferences = state.preferences;
      const direct = state.commands.find((command) => {
        const binding = getShortcutBinding(activePreferences, command.id);
        return command.available && binding && matchShortcut(input, binding, platform);
      });
      if (direct) {
        keyGuard.consume(input.code);
        consume(event);
        executeRef.current(direct.id);
        return;
      }
      if (!state.open) return;
      if (!input.ctrlKey && !input.metaKey && !input.altKey && !input.shiftKey) {
        if (input.key === 'Escape') {
          keyGuard.consume(input.code);
          consume(event);
          setOpen(false);
          return;
        }
        if (input.key === 'ArrowUp' || input.key === 'ArrowDown') {
          const next = nextAvailableCommand(
            state.entries,
            state.selected,
            input.key === 'ArrowUp' ? -1 : 1,
          );
          keyGuard.consume(input.code);
          consume(event);
          setSelected(next);
          if (next) buttons.current.get(next)?.focus();
          return;
        }
        if (
          input.key === 'Enter' &&
          event.target instanceof Element &&
          event.target.closest('[data-shortcut-commands]') &&
          state.selected
        ) {
          keyGuard.consume(input.code);
          consume(event);
          executeRef.current(state.selected);
          return;
        }
      }
      const id = navigationCommand(input, state.preferences, state.entries);
      if (!id) return;
      keyGuard.consume(input.code);
      consume(event);
      executeRef.current(id);
    }
    function onKeyUp(event: KeyboardEvent) {
      if (keyGuard.release(event.code)) consume(event);
    }
    const start = () => keyGuard.compositionStart();
    const end = () => keyGuard.compositionEnd(performance.now());
    const reset = () => keyGuard.reset();
    const visibility = () => {
      if (document.visibilityState !== 'visible') reset();
    };
    // Capture must run before xterm's target listener writes data to the PTY.
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('compositionstart', start, true);
    document.addEventListener('compositionend', end, true);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', reset);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('compositionstart', start, true);
      document.removeEventListener('compositionend', end, true);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', reset);
      reset();
    };
  }, [platform]);

  const availability = JSON.stringify(allCommands.map(({ id, available }) => [id, available]));
  const nativeSync = useRef<() => void>(() => {});
  useLayoutEffect(() => nativeSync.current(), [preferences.data, availability, contextKey, open]);
  useEffect(() => {
    const bridge = window.atelierShortcuts;
    if (!bridge) return;
    let registration: {
      revision: string;
      bindings: ReturnType<typeof resolveShortcutBindings>;
    } | null = null;
    let previous = '';
    let disposed = false;
    function synchronize() {
      if (disposed || !bridge) return;
      const state = latest.current;
      const allowed = new Set(
        state.commands.filter((command) => command.available).map(({ id }) => id),
      );
      const bindings =
        state.preferences?.enabled && !state.open && !scopeBlocked()
          ? resolveShortcutBindings(state.preferences).filter(({ commandId }) =>
              allowed.has(commandId),
            )
          : [];
      const signature = JSON.stringify([state.contextKey, bindings]);
      if (signature === previous) return;
      previous = signature;
      const next = { revision: crypto.randomUUID(), bindings };
      registration = next;
      void bridge.update(next).then(
        () => {
          if (!disposed && registration === next) setNativeFailed(false);
        },
        () => {
          if (!disposed && registration === next) {
            registration = null;
            previous = '';
            setNativeFailed(true);
          }
        },
      );
    }
    nativeSync.current = synchronize;
    const unsubscribe = bridge.onCommand((event) => {
      const state = latest.current;
      const binding = registration?.bindings.find(({ commandId }) => commandId === event.commandId);
      if (
        !registration ||
        event.revision !== registration.revision ||
        !binding ||
        !state.preferences?.enabled ||
        state.open ||
        scopeBlocked()
      )
        return;
      guard.current.consume(binding.binding.code);
      executeRef.current(event.commandId);
    });
    const observer = new MutationObserver(synchronize);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'data-shortcuts-recording', 'hidden', 'inert'],
    });
    document.addEventListener('focusin', synchronize);
    document.addEventListener('focusout', synchronize);
    synchronize();
    return () => {
      disposed = true;
      registration = null;
      nativeSync.current = () => {};
      observer.disconnect();
      unsubscribe();
      document.removeEventListener('focusin', synchronize);
      document.removeEventListener('focusout', synchronize);
      void bridge.update({ revision: crypto.randomUUID(), bindings: [] }).catch(() => {});
    };
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="shortcut-navigator"
        data-shortcut-surface="navigator"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const first = latest.current.entries.find((entry) => entry.available);
          if (first) buttons.current.get(first.id)?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (origin.current?.isConnected) origin.current.focus({ preventScroll: true });
          const action = pending.current;
          pending.current = null;
          if (action)
            requestAnimationFrame(() => {
              const state = latest.current;
              if (action.context !== state.contextKey || !state.preferences?.enabled) return;
              state.commands
                .find((command) => command.id === action.id && command.available)
                ?.run();
            });
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('navigatorTitle')}</DialogTitle>
          <DialogDescription>{t('navigatorDescription')}</DialogDescription>
        </DialogHeader>
        <div className="shortcut-command-list" data-shortcut-commands>
          {entries.map(({ id, label, description, icon: Icon, available }) => {
            const binding = preferences.data && getShortcutBinding(preferences.data, id);
            const key = preferences.data && getNavigationKey(preferences.data, id);
            return (
              <Button
                key={id}
                ref={(element) => {
                  if (element) buttons.current.set(id, element);
                  else buttons.current.delete(id);
                }}
                variant="ghost"
                className="shortcut-command"
                disabled={!available}
                aria-keyshortcuts={key ?? undefined}
                title={available ? description : t('unavailable')}
                data-selected={selected === id}
                onFocus={() => setSelected(id)}
                onClick={() => execute(id)}
              >
                {Icon ? <Icon data-icon="inline-start" aria-hidden="true" /> : null}
                <span className="shortcut-command-label">{label}</span>
                {!available ? (
                  <span className="shortcut-command-status">{t('unavailable')}</span>
                ) : null}
                {binding ? <kbd>{formatShortcutBinding(binding, platform)}</kbd> : null}
                {key ? <kbd className="shortcut-navigation-key">{key}</kbd> : null}
              </Button>
            );
          })}
        </div>
        <p className="shortcut-footer">
          {nativeFailed ? t('nativeUnavailable') : t('navigatorHint')}
        </p>
      </DialogContent>
    </Dialog>
  );
}
