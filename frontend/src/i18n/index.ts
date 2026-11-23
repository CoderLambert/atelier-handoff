/**
 * @file 装配工作台翻译、语言切换和错误展示。
 * @implementation 使用受控桌面接口或同源存储读取和保存界面语言，React 监听实际生效的语言。
 * @updated 2026-11-22T15:00:00+08:00
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DesktopUiLanguageBridge } from '@shared/desktop-ui-language';
import { createUiI18n, type UiNamespace } from '@shared/i18n';
import {
  defaultUiLocale,
  resolveUiLocale,
  uiLocaleSchema,
  type UiLocale,
} from '@shared/i18n/locale';

export type { UiLocale } from '@shared/i18n/locale';

const storageKey = 'atelier.ui-language.v1';
export const uiI18n = createUiI18n(defaultUiLocale);

function desktopBridge(): DesktopUiLanguageBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { atelierUiLanguage?: DesktopUiLanguageBridge }).atelierUiLanguage;
}

async function withDeadline<T>(result: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('UI_LANGUAGE_READ_TIMEOUT')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function initializeUiLanguage(): Promise<void> {
  let locale: UiLocale = defaultUiLocale;
  try {
    const desktop = desktopBridge();
    locale = resolveUiLocale(
      desktop ? await withDeadline(desktop.get()) : localStorage.getItem(storageKey),
    );
  } catch {
    // An unreadable preference still allows the workspace to open in its default language.
  }
  await uiI18n.changeLanguage(locale);
  applyDocumentLanguage();
  uiI18n.on('languageChanged', applyDocumentLanguage);
}

export function getUiLocale(): UiLocale {
  return resolveUiLocale(uiI18n.resolvedLanguage ?? uiI18n.language);
}

function applyDocumentLanguage(): void {
  document.documentElement.lang = getUiLocale();
  document.title = getTranslator('common')('app.title');
}

export function useUiTranslation<Namespace extends UiNamespace>(namespace: Namespace) {
  const { t } = useTranslation(namespace, { i18n: uiI18n, useSuspense: false });
  return { t, locale: getUiLocale() };
}

export function getTranslator<Namespace extends UiNamespace>(namespace: Namespace) {
  return uiI18n.getFixedT(null, namespace);
}

export function useUiLanguage() {
  const { locale, t } = useUiTranslation('common');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function saveLocale(next: UiLocale): Promise<void> {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const requested = uiLocaleSchema.parse(next);
      const desktop = desktopBridge();
      if (desktop) {
        const saved = uiLocaleSchema.parse(await desktop.set(requested));
        await uiI18n.changeLanguage(saved);
      } else {
        localStorage.setItem(storageKey, requested);
        await uiI18n.changeLanguage(requested);
      }
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }
  return { locale, saveLocale, pending, error: failed ? t('language.saveFailed') : null };
}

const errors = new Map<string, keyof typeof import('@shared/i18n/catalogs/common').common>([
  ['CONFLICT', 'errors.conflict'],
  ['RUN_CHANGED', 'errors.conflict'],
  ['OPERATION_CHANGED', 'errors.conflict'],
  ['NOT_FOUND', 'errors.unavailable'],
  ['ATTACHMENT_UNAVAILABLE', 'errors.unavailable'],
  ['ARTIFACT_UNAVAILABLE', 'errors.unavailable'],
  ['INVALID_INPUT', 'errors.invalidInput'],
  ['INVALID_GATEWAY', 'errors.invalidInput'],
  ['PERMISSION_RESPONSE_MISMATCH', 'errors.permissionResponseMismatch'],
  ['PERMISSION_EXPIRED', 'errors.permissionExpired'],
  ['PERMISSION_CHANGED', 'errors.permissionExpired'],
  ['SERVER_BUSY', 'errors.busy'],
  ['FILE_ACTION_UNAVAILABLE', 'errors.fileActionUnavailable'],
  ['FILE_COPY_MISSING', 'errors.fileCopyMissing'],
  ['INVALID_MODEL_CATALOG', 'errors.modelCatalogInvalid'],
  ['UPLOAD_TOO_LARGE', 'errors.fileTooLarge'],
  ['ARTIFACT_TOO_LARGE', 'errors.fileTooLarge'],
  ['PATH_DENIED', 'errors.pathDenied'],
  ['SESSION_ARCHIVED', 'errors.sessionArchived'],
  ['RUN_ACTIVE', 'errors.runActive'],
]);

export function translateError(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const key = typeof code === 'string' ? errors.get(code) : undefined;
  return key ? getTranslator('common')(key) : fallback;
}
