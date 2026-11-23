/**
 * @file 前端统一数据展示与单位格式化工具。
 * @implementation 提供文件尺寸、绝对日期、相对时长和会话时间的格式化，支持当前语言环境。
 * @updated 2026-11-23T18:25:00+08:00
 */
import { getTranslator, getUiLocale, type UiLocale } from '@/i18n';

/**
 * 格式化字节尺寸。
 * @param bytes 字节数
 * @param locale 界面语言
 * @param binary 是否使用 KiB/MiB 二进制单位
 */
export function formatBytes(bytes: number, locale: UiLocale = getUiLocale(), binary = false): string {
  if (bytes < 1024) return `${bytes.toLocaleString(locale)} B`;
  const units = binary ? ['KiB', 'MiB', 'GiB', 'TiB'] : ['KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  const amount = bytes / 1024 ** (index + 1);
  const formatted = amount.toLocaleString(locale, {
    minimumFractionDigits: binary ? 0 : 1,
    maximumFractionDigits: 1,
  });
  return `${formatted} ${units[index]}`;
}

/**
 * 格式化时间戳字符串为简写日期与时间。
 */
export function formatDate(value: string | null | undefined, locale: UiLocale = getUiLocale()): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
}

/**
 * 格式化执行耗时（毫秒）。
 */
export function formatDuration(ms: number | null | undefined, locale: UiLocale = getUiLocale()): string {
  const t = getTranslator('inspector');
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return t('format.milliseconds', { value: Math.round(ms).toLocaleString(locale) });
  if (ms < 60000)
    return t('format.seconds', {
      value: (ms / 1000).toLocaleString(locale, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    });
  return t('format.minutesSeconds', {
    minutes: Math.floor(ms / 60000).toLocaleString(locale),
    seconds: Math.floor((ms % 60000) / 1000).toLocaleString(locale),
  });
}

/**
 * 格式化侧边栏会话的相对/绝对更新时间。
 */
export function formatSessionTime(updatedAt: Date, now: Date, locale: string): string {
  if (updatedAt.getFullYear() !== now.getFullYear()) {
    return updatedAt.toLocaleDateString(locale, { dateStyle: 'short' });
  }
  if (updatedAt.getMonth() === now.getMonth() && updatedAt.getDate() === now.getDate()) {
    return updatedAt.toLocaleTimeString(locale, { timeStyle: 'short' });
  }
  return updatedAt.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
}
