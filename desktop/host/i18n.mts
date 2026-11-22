/**
 * @file 持有主进程翻译实例与可延迟翻译的恢复故障。
 * @implementation 原生弹窗打开时读取当前语言，将故障语义键与原始诊断分开保存。
 * @updated 2026-11-22T16:00:00+08:00
 */
import { createUiI18n } from '../../shared/i18n/index.js';
import { defaultUiLocale } from '../../shared/i18n/locale.js';
import type { desktop } from '../../shared/i18n/catalogs/desktop.js';

export const desktopI18n = createUiI18n(defaultUiLocale);
export const desktopT = desktopI18n.getFixedT(null, 'desktop');
export type DesktopFailureKey = Extract<keyof typeof desktop, `host.failure.${string}`>;

export function formatDesktopNumber(value: number): string {
  return new Intl.NumberFormat(desktopI18n.resolvedLanguage ?? defaultUiLocale).format(value);
}

export class DesktopHostError extends Error {
  constructor(
    readonly key: DesktopFailureKey,
    diagnostic?: unknown,
  ) {
    super(key, { cause: diagnostic });
    this.name = 'DesktopHostError';
  }
}

export function asDesktopHostError(error: unknown): DesktopHostError {
  return error instanceof DesktopHostError
    ? error
    : new DesktopHostError('host.failure.startupFailed', error);
}

export function diagnosticText(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack ?? error.message;
  return typeof error === 'string' && error.trim() ? error : undefined;
}
