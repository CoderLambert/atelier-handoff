/**
 * @file 定义多提交计划编辑器的共享视图类型、分类映射和标识辅助函数。
 * @implementation 隔离受控组列表、待分配清单和底部预览栏共用的数据结构与单位分类逻辑。
 * @updated 2026-11-27T21:50:00+08:00
 */
import type { ReactNode } from 'react';

export type GitMultiCommitLayer = 'staged' | 'unstaged' | 'untracked' | 'conflict';

/** IDs identify units, so the staged and unstaged versions of a path need different IDs. */
export interface GitMultiCommitUnit {
  readonly id: string;
  readonly path: string;
  readonly layer: GitMultiCommitLayer;
  readonly description: string;
  /** Stable server reason for presentation only; it does not decide whether assignment is allowed. */
  readonly reason?: string | null;
  /** Already localized by the parent. A defined reason prevents assignment to a commit. */
  readonly blockedReason?: string;
  readonly credential: boolean;
  readonly note?: string;
  readonly analysis: 'unanalyzed' | 'withheld' | 'modelUnassigned' | 'assigned' | 'manual';
}

export interface GitMultiCommitGroup {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly unitIds: readonly string[];
}

/** A successful preflight snapshot and the exact per-group diff supplied by the parent. */
export interface GitMultiCommitPreview {
  readonly groups: readonly GitMultiCommitGroup[];
  readonly excludedUnitIds: readonly string[];
  readonly renderGroupDiff: (group: GitMultiCommitGroup, index: number) => ReactNode;
}

export type GitMultiCommitCategory =
  | 'protected'
  | 'credentials'
  | 'localOnly'
  | 'dependency'
  | 'conflict'
  | 'rename'
  | 'limits'
  | 'index'
  | 'other'
  | 'unassigned'
  | 'unanalyzed'
  | 'modelUnassigned'
  | 'assigned';

export type InventoryView = 'group' | 'pending' | 'unanalyzed' | 'all' | 'retained';

export const unassignedValue = 'unassigned';
export const excludedValue = 'excluded';
export const groupValue = (id: string) => 'group:' + id;

export const categories: readonly GitMultiCommitCategory[] = [
  'protected',
  'credentials',
  'localOnly',
  'dependency',
  'conflict',
  'rename',
  'limits',
  'index',
  'other',
  'modelUnassigned',
  'unassigned',
  'unanalyzed',
  'assigned',
];

export function unitCategory(unit: GitMultiCommitUnit, assigned: boolean): GitMultiCommitCategory {
  if (unit.credential) return unit.blockedReason ? 'credentials' : 'localOnly';
  if (unit.blockedReason === undefined) {
    if (assigned) return 'assigned';
    if (unit.analysis === 'withheld') return 'dependency';
    if (unit.analysis === 'assigned' || unit.analysis === 'manual') return 'unassigned';
    return unit.analysis;
  }
  switch (unit.reason) {
    case 'restrictedPath':
      return 'protected';
    case 'conflict':
      return 'conflict';
    case 'rename':
      return 'rename';
    case 'unreadable':
    case 'tooLarge':
    case 'budget':
    case 'diffLimit':
      return 'limits';
    case 'indexFlags':
    case 'intentToAdd':
    case 'attributes':
      return 'index';
    default:
      return unit.analysis === 'withheld' && unit.reason === null ? 'dependency' : 'other';
  }
}
