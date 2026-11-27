/**
 * @file 提供独立受控的多提交计划编辑视图，组合左侧分组栏、右侧候选清单、预览区与底部操作栏。
 * @implementation 移除父层注入的 messages 文案树，直接由内部子组件按 git 命名空间读取双语词条并维护选中与视图状态。
 * @updated 2026-11-27T21:55:00+08:00
 */
import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useUiTranslation } from '@/i18n';
import { GitMultiCommitFooter, GitMultiCommitPreviewPane } from './git-multi-commit-footer';
import { GitMultiCommitGroupList } from './git-multi-commit-group-list';
import { GitMultiCommitInventory } from './git-multi-commit-inventory';
import type {
  GitMultiCommitGroup,
  GitMultiCommitLayer,
  GitMultiCommitPreview,
  GitMultiCommitUnit,
  InventoryView,
} from './git-multi-commit-types';
import './git-multi-commit-editor.css';

export type { GitMultiCommitGroup, GitMultiCommitLayer, GitMultiCommitPreview, GitMultiCommitUnit };

export interface GitMultiCommitEditorProps {
  readonly units: readonly GitMultiCommitUnit[];
  readonly groups: readonly GitMultiCommitGroup[];
  readonly excludedUnitIds: readonly string[];
  readonly activeGroupId: string | null;
  readonly status?: 'ready' | 'loading' | 'previewing' | 'submitting';
  readonly preview?: GitMultiCommitPreview | null;
  readonly canConfirm: boolean;
  readonly previewBlockedReason?: string;
  readonly disabled?: boolean;
  readonly hidden?: boolean;
  readonly onGroupsChange: (
    groups: readonly GitMultiCommitGroup[],
    excludedUnitIds: readonly string[],
  ) => void;
  readonly onActiveGroupChange: (groupId: string | null) => void;
  readonly onAddGroup: () => void;
  readonly onPreview: () => void;
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
}

function inspectPlan(
  units: readonly GitMultiCommitUnit[],
  groups: readonly GitMultiCommitGroup[],
  excludedUnitIds: readonly string[],
) {
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const groupIds = new Set(groups.map((group) => group.id));
  const excludedIds = new Set(excludedUnitIds);
  const ownerByUnit = new Map<string, string>();
  let invalid =
    unitById.size !== units.length ||
    groupIds.size !== groups.length ||
    excludedIds.size !== excludedUnitIds.length;
  for (const unitId of excludedIds) {
    if (!unitById.has(unitId)) invalid = true;
  }
  for (const group of groups) {
    for (const unitId of group.unitIds) {
      const unit = unitById.get(unitId);
      if (
        !unit ||
        unit.blockedReason !== undefined ||
        ownerByUnit.has(unitId) ||
        excludedIds.has(unitId)
      ) {
        invalid = true;
      }
      ownerByUnit.set(unitId, group.id);
    }
  }
  return { invalid, ownerByUnit, excludedIds };
}

function matchesPreview(
  groups: readonly GitMultiCommitGroup[],
  excludedUnitIds: readonly string[],
  preview: GitMultiCommitPreview | null | undefined,
) {
  return Boolean(
    preview &&
    groups.length === preview.groups.length &&
    excludedUnitIds.length === preview.excludedUnitIds.length &&
    excludedUnitIds.every((id) => preview.excludedUnitIds.includes(id)) &&
    groups.every((group, index) => {
      const previous = preview.groups[index];
      return (
        previous &&
        group.id === previous.id &&
        group.title === previous.title &&
        group.body === previous.body &&
        group.unitIds.length === previous.unitIds.length &&
        group.unitIds.every((id, unitIndex) => id === previous.unitIds[unitIndex])
      );
    }),
  );
}

/** A controlled view: unassigned units are derived from the complete, immutable candidate list. */
export function GitMultiCommitEditor({
  units,
  groups,
  excludedUnitIds,
  activeGroupId,
  status = 'ready',
  preview,
  canConfirm,
  previewBlockedReason,
  disabled = false,
  hidden,
  onGroupsChange,
  onActiveGroupChange,
  onAddGroup,
  onPreview,
  onConfirm,
  onCancel,
}: GitMultiCommitEditorProps) {
  const { t } = useUiTranslation('git');
  const fields = useId();
  const [selectedView, setView] = useState<InventoryView>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const inventoryViews = useRef<HTMLFieldSetElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);

  const { invalid, ownerByUnit, excludedIds } = inspectPlan(units, groups, excludedUnitIds);
  const activeIndex = Math.max(
    0,
    groups.findIndex((group) => group.id === activeGroupId),
  );
  const activeGroup = groups[activeIndex];
  const busy = status !== 'ready';
  const locked = disabled || busy || invalid;
  const incomplete = groups.some((group) => !group.title.trim() || group.unitIds.length === 0);
  const unresolved = units.filter((unit) => !ownerByUnit.has(unit.id) && !excludedIds.has(unit.id));
  const unanalyzed = unresolved.filter((unit) => unit.analysis === 'unanalyzed');
  const pendingUnits = unresolved.filter((unit) => unit.analysis !== 'unanalyzed');
  const retainedUnits = units.filter((unit) => excludedIds.has(unit.id));
  const groupUnits = activeGroup
    ? units.filter((unit) => ownerByUnit.get(unit.id) === activeGroup.id)
    : [];
  const visible: Readonly<Record<InventoryView, readonly GitMultiCommitUnit[]>> = {
    group: groupUnits,
    pending: pendingUnits,
    unanalyzed,
    all: units,
    retained: retainedUnits,
  };
  const defaultView: InventoryView =
    activeGroup && (activeGroup.unitIds.length || !pendingUnits.length)
      ? 'group'
      : pendingUnits.length
        ? 'pending'
        : 'unanalyzed';
  const view: InventoryView =
    (selectedView === 'group' && !activeGroup) ||
    (selectedView === 'unanalyzed' && !unanalyzed.length)
      ? defaultView
      : (selectedView ?? defaultView);
  const previewCurrent = matchesPreview(groups, excludedUnitIds, preview);

  useEffect(() => {
    const heading = previewHeading.current;
    if (!previewCurrent || !heading) return;
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
  }, [previewCurrent]);

  const previewDisabled =
    locked ||
    Boolean(previewBlockedReason) ||
    groups.length === 0 ||
    incomplete ||
    unresolved.length > 0;
  const confirmDisabled = previewDisabled || !canConfirm || !previewCurrent;

  const blockingReasons = [
    busy
      ? status === 'loading'
        ? t('multi.loading')
        : status === 'previewing'
          ? t('multi.previewing')
          : t('multi.submitting')
      : null,
    disabled ? t('multi.unavailable') : null,
    previewBlockedReason,
    invalid ? t('multi.invalidPlan') : null,
    groups.length === 0 ? t('multi.noGroups') : null,
    pendingUnits.length ? t('multi.unassignedAction', { count: pendingUnits.length }) : null,
    unanalyzed.length ? t('multi.unanalyzedAction', { count: unanalyzed.length }) : null,
    ...groups.flatMap((group, index) => {
      const label = t('multi.groupLabel', { number: index + 1, title: group.title });
      return [
        !group.title.trim()
          ? t('multi.groupIssue', { group: label, issue: t('multi.titleRequired') })
          : null,
        group.unitIds.length === 0
          ? t('multi.groupIssue', { group: label, issue: t('multi.emptyGroup') })
          : null,
      ];
    }),
  ].filter((reason): reason is string => Boolean(reason));

  const focusInventoryView = (target: InventoryView = view) =>
    inventoryViews.current?.querySelector<HTMLInputElement>(`input[value="${target}"]`)?.focus();

  function updateActive(patch: Partial<Pick<GitMultiCommitGroup, 'title' | 'body'>>) {
    if (locked || !activeGroup) return;
    onGroupsChange(
      groups.map((group) => (group.id === activeGroup.id ? { ...group, ...patch } : group)),
      [...excludedUnitIds],
    );
  }

  function moveActive(offset: -1 | 1) {
    if (locked || !activeGroup) return;
    const targetIndex = activeIndex + offset;
    const target = groups[targetIndex];
    if (!target) return;
    const next = [...groups];
    next[activeIndex] = target;
    next[targetIndex] = activeGroup;
    onGroupsChange(next, [...excludedUnitIds]);
  }

  function mergeActive(offset: -1 | 1) {
    if (locked || !activeGroup) return;
    const target = groups[activeIndex + offset];
    if (!target) return;
    const unitIds =
      offset === -1
        ? [...target.unitIds, ...activeGroup.unitIds]
        : [...activeGroup.unitIds, ...target.unitIds];
    onGroupsChange(
      groups
        .filter((group) => group.id !== activeGroup.id)
        .map((group) => (group.id === target.id ? { ...group, unitIds } : group)),
      [...excludedUnitIds],
    );
    onActiveGroupChange(target.id);
  }

  function removeActive() {
    if (locked || !activeGroup) return;
    const next = groups.filter((group) => group.id !== activeGroup.id);
    // Candidates stay in units; removing their owner returns them to the reserved inventory.
    onGroupsChange(next, [...excludedUnitIds]);
    onActiveGroupChange(next[Math.min(activeIndex, next.length - 1)]?.id ?? null);
  }

  function selectUnits(candidates: readonly GitMultiCommitUnit[], checked: boolean) {
    if (locked) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const { id } of candidates) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function moveUnits(ids: readonly string[], value: string) {
    if (locked || !ids.length) return;
    const moving = new Set(ids);
    const candidates = units.filter(({ id }) => moving.has(id));
    if (candidates.length !== moving.size) return;
    const targetGroupId = value.startsWith('group:') ? value.slice('group:'.length) : null;
    const target = targetGroupId ? groups.find((group) => group.id === targetGroupId) : undefined;
    if (value !== 'unassigned' && value !== 'excluded' && !target) return;
    if (target && candidates.some((unit) => unit.blockedReason !== undefined)) return;
    if (
      (view === 'pending' && value !== 'unassigned') ||
      (view === 'unanalyzed' && value !== 'unassigned') ||
      (view === 'retained' && value !== 'excluded') ||
      (view === 'group' && target?.id !== activeGroup?.id)
    ) {
      focusInventoryView();
    }
    const excluded = excludedUnitIds.filter((id) => !moving.has(id));
    if (value === 'excluded') excluded.push(...ids);
    selectUnits(candidates, false);
    onGroupsChange(
      groups.map((group) => {
        const unitIds = group.unitIds.filter((id) => !moving.has(id));
        if (target?.id === group.id) unitIds.push(...ids);
        return { ...group, unitIds };
      }),
      excluded,
    );
  }

  return (
    <section
      className="git-multi-commit"
      hidden={hidden}
      aria-labelledby={fields + '-groups'}
      aria-busy={busy}
    >
      <div
        className="git-multi-commit-scroll"
        role="region"
        aria-label={t('multi.groups')}
        tabIndex={0}
      >
        {status === 'previewing' || status === 'submitting' ? (
          <p className="git-multi-commit-status" role="status">
            <LoaderCircle aria-hidden="true" />
            {status === 'previewing' ? t('multi.previewing') : t('multi.submitting')}
          </p>
        ) : null}
        <div className="git-multi-commit-columns">
          <GitMultiCommitGroupList
            fieldsPrefix={fields}
            groups={groups}
            activeIndex={activeIndex}
            activeGroup={activeGroup}
            busy={busy}
            disabled={disabled}
            locked={locked}
            onAddGroup={onAddGroup}
            onSelectGroup={onActiveGroupChange}
            onUpdateActive={updateActive}
            onMoveActive={moveActive}
            onMergeActive={mergeActive}
            onRemoveActive={removeActive}
          />
          <GitMultiCommitInventory
            fieldsPrefix={fields}
            inventoryViewsRef={inventoryViews}
            units={units}
            groups={groups}
            activeGroup={activeGroup}
            ownerByUnit={ownerByUnit}
            excludedIds={excludedIds}
            view={view}
            visible={visible}
            pendingUnits={pendingUnits}
            unanalyzed={unanalyzed}
            retainedCount={retainedUnits.length}
            selectedIds={selectedIds}
            locked={locked}
            onViewChange={setView}
            onSelectUnits={selectUnits}
            onClearSelection={() => setSelectedIds(new Set())}
            onMoveUnits={moveUnits}
            onRestoreFocus={() => focusInventoryView()}
          />
        </div>
        {preview ? (
          <GitMultiCommitPreviewPane
            fieldsPrefix={fields}
            previewHeadingRef={previewHeading}
            groups={preview.groups}
            preview={preview}
          />
        ) : null}
      </div>
      <GitMultiCommitFooter
        fieldsPrefix={fields}
        status={status}
        blockingReasons={blockingReasons}
        pendingCount={pendingUnits.length}
        unanalyzedCount={unanalyzed.length}
        previewCurrent={previewCurrent}
        previewDisabled={previewDisabled}
        confirmDisabled={confirmDisabled}
        onJumpToInventory={(target) => {
          setView(target);
          focusInventoryView(target);
        }}
        onCancel={onCancel}
        onPreview={onPreview}
        onConfirm={onConfirm}
      />
    </section>
  );
}
