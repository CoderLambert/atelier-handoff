/**
 * @file 定义聊天输入的运行模式与显示文案。
 * @implementation 根据已保存的执行器、模式和审批记录派生界面选项，并解析临时搜索额度。
 * @updated 2026-11-22T16:22:55+08:00
 */
import { getTranslator } from '@/i18n';
import type { Draft, Run } from '@shared/types';

export type ComposerMode = 'readonly' | 'edit' | 'automatic' | 'native';
export function composerMode(
  draft: Draft,
  readonlyProfile = false,
  nativeExecution = false,
): ComposerMode {
  if (readonlyProfile) return 'readonly';
  if (draft.mode === 'edit' && draft.approvalMode === 'automatic') return 'automatic';
  if (draft.mode === 'edit' && draft.executionPreference === 'native-v1' && nativeExecution)
    return 'native';
  return draft.mode;
}
export function withComposerMode(draft: Draft, mode: ComposerMode): Draft {
  return {
    ...draft,
    mode: mode === 'automatic' || mode === 'native' ? 'edit' : mode,
    approvalMode: mode === 'automatic' ? 'automatic' : undefined,
    executionPreference: mode === 'native' ? 'native-v1' : 'project-v1',
  };
}
export function parseSearchChargeLimit(value: string): number | undefined {
  const t = getTranslator('chat');
  if (!value.trim()) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(t('mode.invalidSearchLimit'));
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 100000) throw new Error(t('mode.invalidSearchLimit'));
  return limit;
}

export function runModeLabel(run: Run): string {
  const t = getTranslator('chat');
  if (run.executor === 'native-v1') return t('mode.native');
  if (run.approvalMode === 'automatic') return t('mode.automatic');
  return run.mode === 'edit' ? t('mode.controlledRun') : t('mode.readonly');
}
