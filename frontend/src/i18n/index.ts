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
  ['FILE_TOO_LARGE', 'errors.fileTooLarge'],
  ['CONTEXT_TOO_LARGE', 'errors.fileTooLarge'],
  ['PATH_DENIED', 'errors.pathDenied'],
  ['SESSION_ARCHIVED', 'errors.sessionArchived'],
  ['RUN_ACTIVE', 'errors.runActive'],
]);

type GitErrorKey = Extract<
  keyof typeof import('@shared/i18n/catalogs/git').git,
  `errors.${string}`
>;

const gitErrors = new Map<string, GitErrorKey>([
  ['GIT_UNAVAILABLE', 'errors.unavailable'],
  ['GIT_NOT_REPOSITORY', 'errors.notRepository'],
  ['GIT_INVALID_BRANCH', 'errors.invalidBranch'],
  ['GIT_BRANCH_EXISTS', 'errors.branchExists'],
  ['GIT_BASE_MISSING', 'errors.baseMissing'],
  ['GIT_BASE_CHANGED', 'errors.baseChanged'],
  ['GIT_DIRECTORY_DIRTY', 'errors.dirty'],
  ['GIT_DIRECTORY_BUSY', 'errors.busy'],
  ['GIT_DIRECTORY_OVERLAP', 'errors.overlap'],
  ['GIT_WORKTREE_CHANGED', 'errors.changed'],
  ['GIT_WORKTREE_MISSING', 'errors.missing'],
  ['GIT_RESTORE_BRANCH_REQUIRED', 'errors.branchRequired'],
  ['GIT_SNAPSHOT_CORRUPT', 'errors.snapshotCorrupt'],
  ['GIT_RESTORE_UNAVAILABLE', 'errors.occupied'],
  ['GIT_DESTINATION_EXISTS', 'errors.occupied'],
  ['GIT_IN_PROGRESS', 'errors.inProgress'],
  ['GIT_OUTPUT_LIMIT', 'errors.outputLimit'],
  ['GIT_FILE_CHANGED', 'errors.fileChanged'],
  ['GIT_OPERATION_FAILED', 'errors.previousFailed'],
  ['GIT_PLAN_STALE', 'errors.planStale'],
  ['GIT_PLAN_DEPENDENCY', 'errors.planDependency'],
  ['GIT_PLAN_UNSUPPORTED', 'errors.planUnsupported'],
  ['GIT_PLAN_CREDENTIAL', 'errors.planCredential'],
  ['GIT_PLAN_INSTRUCTION_PRIVATE', 'errors.planInstructionPrivate'],
  ['GIT_PLAN_REVISION_FAILED', 'errors.planRevisionFailed'],
  ['GIT_PLAN_REVISION_INVALID', 'errors.planRevisionInvalid'],
  ['GIT_PLAN_ANALYSIS_EXPIRED', 'errors.planAnalysisExpired'],
  ['GIT_PLAN_ANALYSIS_STALE', 'errors.planAnalysisStale'],
  ['GIT_PLAN_UNSAFE_HUNK', 'errors.planUnsupported'],
  ['GIT_PLAN_INVALID', 'errors.planInvalid'],
  ['GIT_PLAN_UNKNOWN_UNIT', 'errors.planInvalid'],
  ['GIT_PLAN_DUPLICATE_UNIT', 'errors.planInvalid'],
  ['GIT_PLAN_UNASSIGNED_UNIT', 'errors.planInvalid'],
  ['GIT_PLAN_EMPTY_GROUP', 'errors.planInvalid'],
  ['GIT_PLAN_PREVIEW_LIMIT', 'errors.planLimit'],
  ['GIT_PLAN_LIMIT', 'errors.planLimit'],
  ['GIT_PLAN_RECOVERY_REQUIRED', 'errors.planRecovery'],
  ['GIT_PLAN_UNFINISHED', 'errors.planRecovery'],
  ['GIT_PLAN_LOCK_LOST', 'errors.planRecovery'],
  ['GIT_PLAN_COORDINATION', 'errors.planRecovery'],
  ['GIT_PLAN_DETACHED_HEAD', 'errors.planDetached'],
  ['GIT_PLAN_INDEX_UNSUPPORTED', 'errors.planIndex'],
  ['GIT_PLAN_INDEX_UNSAFE', 'errors.planIndex'],
  ['GIT_PLAN_PLATFORM', 'errors.planPlatform'],
  ['GIT_PLAN_REQUEST_CONFLICT', 'errors.planConflict'],
  ['GIT_COMMIT_EMPTY', 'errors.commitEmpty'],
  ['GIT_COMMIT_STALE', 'errors.commitStale'],
  ['GIT_COMMIT_IDENTITY', 'errors.commitIdentity'],
  ['GIT_COMMIT_SIGNING', 'errors.commitSigning'],
  ['GIT_COMMIT_WRITE', 'errors.commitWrite'],
]);

export function translateError(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && code.startsWith('GIT_'))
    return getTranslator('git')(gitErrors.get(code) ?? 'errors.failed');
  const key = typeof code === 'string' ? errors.get(code) : undefined;
  return key ? getTranslator('common')(key) : fallback;
}
