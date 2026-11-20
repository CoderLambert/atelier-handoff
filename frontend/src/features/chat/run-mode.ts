/**
 * @file 定义聊天输入的运行模式与显示文案。
 * @implementation 解析付费搜索单次上限，并根据运行记录区分只读、逐次审批和全工具自动化。
 * @updated 2026-11-20T14:44:21+08:00
 */
import type { Run } from '@shared/types';

export type ComposerMode = 'readonly' | 'edit' | 'automatic';
export function parseSearchChargeLimit(value: string): number | undefined {
  if (!value.trim()) return undefined;
  if (!/^\d+$/.test(value)) throw new Error('付费搜索单次上限须为 0–100000 的整数（分）。');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 100000)
    throw new Error('付费搜索单次上限须为 0–100000 的整数（分）。');
  return limit;
}

export function runModeLabel(run: Run): string {
  if (run.approvalMode === 'automatic') return '全工具自动化';
  return run.mode === 'edit' ? '受控修改 · 逐次审批' : '只读';
}
