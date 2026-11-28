/**
 * @file 提供快捷入口和浮层导航键的独立设置表单。
 * @implementation 录制候选按键并保留本地草稿，用共享契约验证保留键与重复；只在保存成功后让运行配置生效。
 * @updated 2026-11-26T22:00:00+08:00
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { CircleOff, Keyboard, RotateCcw } from 'lucide-react';
import {
  defaultShortcutPreferences,
  formatShortcutBinding,
  getNavigationKey,
  getShortcutBinding,
  shortcutBindingSchema,
  shortcutInputFromKeyboardEvent,
  shortcutPreferencesSchema,
  type ShortcutModifier,
  type ShortcutPreferences,
} from '@shared/shortcuts';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useUiTranslation } from '@/i18n';
import { useShortcutPreferences } from '@/use-query/settings/use-shortcut-preferences';
import { useUpdateShortcutPreferences } from '@/use-query/settings/use-update-shortcut-preferences';
import { useShortcutCommandLabels } from './commands';
import { shortcutPlatform } from './shortcut-host';
import { createShortcutKeyGuard } from './shortcut-interaction';
import './shortcuts.css';
import { Input } from '@/components/ui/input';

const modifierCodes = new Set([
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
]);

export function ShortcutSettings() {
  const { t } = useUiTranslation('shortcuts');
  const labels = useShortcutCommandLabels();
  const preferences = useShortcutPreferences();
  const update = useUpdateShortcutPreferences();
  const [draft, setDraft] = useState<ShortcutPreferences>();
  const [recording, setRecording] = useState<string>();
  const [recordingError, setRecordingError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const formId = useId();
  const platform = shortcutPlatform();
  const guard = useRef(createShortcutKeyGuard());
  const form = useRef<HTMLFormElement>(null);
  const value = draft ?? preferences.data;
  const latest = useRef({ recording, value, pending: update.isPending });
  useLayoutEffect(() => {
    latest.current = { recording, value, pending: update.isPending };
  }, [recording, value, update.isPending]);
  const parsed = value && shortcutPreferencesSchema.safeParse(value);
  const preview = value && { ...value, enabled: true };

  function edit(next: ShortcutPreferences) {
    setDraft(next);
    setSaved(false);
    setFailed(false);
  }

  useEffect(() => {
    const keyGuard = guard.current;
    function consume(event: KeyboardEvent) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    function keydown(event: KeyboardEvent) {
      const input = shortcutInputFromKeyboardEvent(event);
      if (keyGuard.suppresses(input)) {
        consume(event);
        return;
      }
      const state = latest.current;
      if (!state.recording || !state.value || state.pending) return;
      if (!(event.target instanceof Node) || !form.current?.contains(event.target)) return;
      if (!keyGuard.accepts(input, performance.now())) return;
      if (input.key === 'Tab') {
        setRecording(undefined);
        return;
      }
      if (modifierCodes.has(input.code)) return;
      keyGuard.consume(input.code);
      consume(event);
      if (input.key === 'Escape') {
        setRecording(undefined);
        setRecordingError(undefined);
        return;
      }
      const modifiers: ShortcutModifier[] = [];
      if (input.ctrlKey) modifiers.push(platform === 'other' ? 'Mod' : 'Control');
      if (input.metaKey) modifiers.push(platform === 'mac' ? 'Mod' : 'Meta');
      if (input.altKey) modifiers.push('Alt');
      if (input.shiftKey) modifiers.push('Shift');
      const candidate = shortcutBindingSchema.safeParse({ code: input.code, modifiers });
      if (!candidate.success) {
        setRecordingError(state.recording);
        return;
      }
      setDraft({
        ...state.value,
        bindings: { ...state.value.bindings, [state.recording]: candidate.data },
      });
      setSaved(false);
      setFailed(false);
      setRecording(undefined);
      setRecordingError(undefined);
    }
    function keyup(event: KeyboardEvent) {
      if (keyGuard.release(event.code)) consume(event);
    }
    const start = () => keyGuard.compositionStart();
    const end = () => keyGuard.compositionEnd(performance.now());
    const reset = () => {
      keyGuard.reset();
      setRecording(undefined);
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('keyup', keyup, true);
    document.addEventListener('compositionstart', start, true);
    document.addEventListener('compositionend', end, true);
    window.addEventListener('blur', reset);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('keyup', keyup, true);
      document.removeEventListener('compositionstart', start, true);
      document.removeEventListener('compositionend', end, true);
      window.removeEventListener('blur', reset);
    };
  }, [platform]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!parsed?.success || update.isPending || recording) return;
    setFailed(false);
    try {
      await update.mutateAsync(parsed.data);
      setDraft(undefined);
      setSaved(true);
    } catch {
      setFailed(true);
    }
  }

  function rowError(id: string) {
    if (recordingError === id) return t('invalidBinding');
    const issue =
      parsed && !parsed.success
        ? parsed.error.issues.find((entry) => entry.path[1] === id)
        : undefined;
    if (!issue) return undefined;
    if (issue.message === 'DUPLICATE_BINDING') return t('duplicateBinding');
    if (issue.message === 'DUPLICATE_NAVIGATION') return t('duplicateNavigation');
    return issue.path[0] === 'navigation' ? t('invalidNavigation') : t('invalidBinding');
  }

  return (
    <form
      ref={form}
      className="shortcut-settings settings-form"
      data-shortcuts-block
      data-shortcuts-recording={Boolean(recording)}
      onSubmit={(event) => void save(event)}
    >
      <div className="settings-section-intro">
        <h2>{t('settingsTitle')}</h2>
        <p>{t('settingsDescription')}</p>
      </div>
      {preferences.isPending ? <p role="status">{t('loading')}</p> : null}
      {preferences.isError && !value ? (
        <div role="alert">
          <p>{t('loadFailed')}</p>
          <Button variant="outline" onClick={() => void preferences.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : null}
      {value && preview ? (
        <>
          <div className="settings-field-row">
            <div className="settings-field-copy">
              <label htmlFor={`${formId}-enabled`}>{t('enabled')}</label>
              <p id={`${formId}-enabled-description`}>{t('enabledDescription')}</p>
            </div>
            <Switch
              id={`${formId}-enabled`}
              checked={value.enabled}
              aria-describedby={`${formId}-enabled-description`}
              disabled={update.isPending}
              onCheckedChange={(enabled) => edit({ ...value, enabled })}
            />
          </div>
          <fieldset className="shortcut-bindings" disabled={update.isPending}>
            <legend className="sr-only">{t('settingsTitle')}</legend>
            <div className="shortcut-config-scroll">
              <table className="shortcut-config-table">
                <thead>
                  <tr>
                    <th scope="col">{t('action')}</th>
                    <th scope="col">{t('directKey')}</th>
                    <th scope="col">{t('navigationKey')}</th>
                    <th scope="col">
                      <span className="sr-only">{t('reset')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(labels).map(([id, { label, icon: Icon }]) => {
                    const binding = getShortcutBinding(preview, id);
                    const navigation = getNavigationKey(preview, id);
                    const error = rowError(id);
                    const errorId = `${formId}-${id}-error`;
                    const isRecording = recording === id;
                    return (
                      <tr key={id}>
                        <th scope="row">
                          <span className="shortcut-setting-label">
                            <Icon aria-hidden="true" />
                            {label}
                          </span>
                        </th>
                        <td>
                          <div className="shortcut-binding-controls">
                            <Button
                              variant={isRecording ? 'secondary' : 'outline'}
                              size="sm"
                              className="shortcut-record"
                              aria-label={t('bindingLabel', { action: label })}
                              aria-describedby={
                                error ? errorId : isRecording ? `${formId}-record-help` : undefined
                              }
                              aria-invalid={Boolean(error)}
                              aria-pressed={isRecording}
                              onClick={() => {
                                setRecording(isRecording ? undefined : id);
                                setRecordingError(undefined);
                              }}
                              onBlur={() => setRecording(undefined)}
                            >
                              <Keyboard data-icon="inline-start" aria-hidden="true" />
                              {isRecording
                                ? t('recording')
                                : binding
                                  ? formatShortcutBinding(binding, platform)
                                  : t('notAssigned')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={!binding}
                              aria-label={t('disableLabel', { action: label })}
                              title={t('disable')}
                              onClick={() =>
                                edit({ ...value, bindings: { ...value.bindings, [id]: null } })
                              }
                            >
                              <CircleOff aria-hidden="true" />
                            </Button>
                          </div>
                          {error ? (
                            <p className="shortcut-field-error" id={errorId} role="alert">
                              {error}
                            </p>
                          ) : null}
                        </td>
                        <td>
                          {id !== 'shortcuts.navigator' ? (
                            <Input
                              className="field shortcut-nav-input"
                              type="text"
                              maxLength={1}
                              autoComplete="off"
                              spellCheck={false}
                              value={navigation ?? ''}
                              aria-label={t('navigationLabel', { action: label })}
                              aria-invalid={Boolean(error)}
                              aria-describedby={error ? errorId : `${formId}-navigation-help`}
                              onChange={(event) =>
                                edit({
                                  ...value,
                                  navigation: {
                                    ...value.navigation,
                                    [id]: event.target.value.toUpperCase() || null,
                                  },
                                })
                              }
                            />
                          ) : null}
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('resetLabel', { action: label })}
                            title={t('reset')}
                            disabled={!(id in value.bindings) && !(id in value.navigation)}
                            onClick={() => {
                              const bindings = { ...value.bindings };
                              const navigationKeys = { ...value.navigation };
                              delete bindings[id];
                              delete navigationKeys[id];
                              edit({ ...value, bindings, navigation: navigationKeys });
                              setRecordingError(undefined);
                            }}
                          >
                            <RotateCcw aria-hidden="true" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="shortcut-help" id={`${formId}-navigation-help`}>
              {t('navigationHint')}
            </p>
            {recording ? (
              <p className="shortcut-help" id={`${formId}-record-help`} role="status">
                {t('recordingHint')}
              </p>
            ) : null}
            <p className="shortcut-help">{t('systemNote')}</p>
          </fieldset>
          <div className="shortcut-settings-actions">
            <Button
              variant="ghost"
              disabled={update.isPending}
              onClick={() => {
                edit({ ...defaultShortcutPreferences, bindings: {}, navigation: {} });
                setRecording(undefined);
                setRecordingError(undefined);
              }}
            >
              <RotateCcw data-icon="inline-start" aria-hidden="true" />
              {t('resetAll')}
            </Button>
            <span className="shortcut-save-status" role="status">
              {failed
                ? t('saveFailed')
                : parsed && !parsed.success
                  ? t('invalidPreferences')
                  : saved
                    ? t('saved')
                    : draft
                      ? t('unsaved')
                      : ''}
            </span>
            <Button
              type="submit"
              disabled={!draft || !parsed?.success || update.isPending || Boolean(recording)}
            >
              {update.isPending ? t('saving') : t('save')}
            </Button>
          </div>
        </>
      ) : null}
    </form>
  );
}
