/**
 * @file 提供独立受控的多提交计划编辑视图。
 * @implementation 优先展示有序提交组，将待决定和未分析项分开，并校验预览仍对应当前计划。
 * @updated 2026-11-24T14:50:21+08:00
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  GitCommitHorizontal,
  LoaderCircle,
  Plus,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/components/ui/utils';
import './git-multi-commit-editor.css';

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
  readonly analysis: 'unanalyzed' | 'withheld' | 'modelUnassigned' | 'assigned';
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

type GitMultiCommitCategory =
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

type InventoryView = 'group' | 'pending' | 'unanalyzed' | 'all' | 'retained';

/** All application-owned visible text and accessible names come from the parent. */
export interface GitMultiCommitEditorMessages {
  readonly inventory: {
    readonly views: string;
    readonly group: string;
    readonly pending: string;
    readonly unanalyzed: string;
    readonly all: string;
    readonly retained: string;
    readonly noRetained: string;
    readonly retainCategory: string;
    readonly categories: Readonly<
      Record<GitMultiCommitCategory, { title: string; reason: string }>
    >;
    readonly retainCategoryLabel: (category: string, count: number) => string;
    readonly assignedTo: (group: string) => string;
  };
  readonly contentLabel: string;
  readonly groups: string;
  readonly activeGroup: string;
  readonly addGroup: string;
  readonly removeGroup: string;
  readonly moveGroupUp: string;
  readonly moveGroupDown: string;
  readonly mergeWithPrevious: string;
  readonly mergeWithNext: string;
  readonly mergeHint: string;
  readonly title: string;
  readonly body: string;
  readonly titlePlaceholder: string;
  readonly bodyPlaceholder: string;
  readonly noGroups: string;
  readonly noUnits: string;
  readonly units: string;
  readonly assignment: string;
  readonly unassigned: string;
  readonly excluded: string;
  readonly noUnassigned: string;
  readonly cannotPreview: string;
  readonly cannotConfirm: string;
  readonly unavailable: string;
  readonly moreIssues: string;
  readonly blocked: string;
  readonly layers: Readonly<Record<GitMultiCommitLayer, string>>;
  readonly removalHint: string;
  readonly invalidPlan: string;
  readonly titleRequired: string;
  readonly emptyGroup: string;
  readonly loading: string;
  readonly submitting: string;
  readonly preview: string;
  readonly previewing: string;
  readonly previewHeading: string;
  readonly confirm: string;
  readonly commitNotice: string;
  readonly cancel: string;
  /** These format whole phrases, including any numbers and plural forms, in the current locale. */
  readonly groupLabel: (position: number, title: string) => string;
  readonly unitCount: (count: number) => string;
  readonly unassignedAction: (count: number) => string;
  readonly unanalyzedAction: (count: number) => string;
  readonly groupIssue: (groupLabel: string, issue: string) => string;
}

export interface GitMultiCommitEditorProps {
  readonly units: readonly GitMultiCommitUnit[];
  readonly groups: readonly GitMultiCommitGroup[];
  readonly excludedUnitIds: readonly string[];
  readonly activeGroupId: string | null;
  readonly messages: GitMultiCommitEditorMessages;
  readonly status?: 'ready' | 'loading' | 'previewing' | 'submitting';
  /** Immutable successful preflight snapshot; edits automatically invalidate its display and gate. */
  readonly preview?: GitMultiCommitPreview | null;
  /** Parent-owned checks such as snapshot freshness or backend availability. */
  readonly canConfirm: boolean;
  /** Parent-owned reason that blocks both preview and confirmation. */
  readonly previewBlockedReason?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  /** Apply both arrays atomically so moving a unit between commits and exclusion has one owner. */
  readonly onGroupsChange: (groups: GitMultiCommitGroup[], excludedUnitIds: string[]) => void;
  readonly onActiveGroupChange: (groupId: string | null) => void;
  /** Parent creates a unique ID, appends an empty group, and selects it. */
  readonly onAddGroup: () => void;
  /** Parent validates against the repository and supplies exact diffs without executing commits. */
  readonly onPreview: () => void;
  /** Parent must set status to submitting synchronously when execution starts. */
  readonly onConfirm: () => void;
  readonly onCancel?: () => void;
}

const categories: readonly GitMultiCommitCategory[] = [
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

function unitCategory(unit: GitMultiCommitUnit, assigned: boolean): GitMultiCommitCategory {
  if (unit.credential) return unit.blockedReason ? 'credentials' : 'localOnly';
  if (unit.blockedReason === undefined) {
    if (assigned) return 'assigned';
    if (unit.analysis === 'withheld') return 'dependency';
    if (unit.analysis === 'assigned') return 'unassigned';
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
const unassignedValue = 'unassigned';
const excludedValue = 'excluded';
const groupValue = (id: string) => 'group:' + id;

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
  for (const unitId of excludedIds) if (!unitById.has(unitId)) invalid = true;
  for (const group of groups) {
    for (const unitId of group.unitIds) {
      const unit = unitById.get(unitId);
      if (
        !unit ||
        unit.blockedReason !== undefined ||
        ownerByUnit.has(unitId) ||
        excludedIds.has(unitId)
      )
        invalid = true;
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
  messages,
  status = 'ready',
  preview,
  canConfirm,
  previewBlockedReason,
  disabled = false,
  className,
  onGroupsChange,
  onActiveGroupChange,
  onAddGroup,
  onPreview,
  onConfirm,
  onCancel,
}: GitMultiCommitEditorProps) {
  const fields = useId();
  const [selectedView, setView] = useState<InventoryView>();
  const [expandedCategories, setExpandedCategories] = useState<
    Partial<Record<GitMultiCommitCategory, boolean>>
  >({});
  const inventoryViews = useRef<HTMLFieldSetElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const inventory = messages.inventory;
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
  const retainedCount = units.filter((unit) => excludedIds.has(unit.id)).length;
  const groupUnits = activeGroup
    ? units.filter((unit) => ownerByUnit.get(unit.id) === activeGroup.id)
    : [];
  const visible = {
    group: groupUnits,
    pending: pendingUnits,
    unanalyzed,
    all: units,
    retained: units.filter((unit) => excludedIds.has(unit.id)),
  };
  const defaultView = activeGroup ? 'group' : pendingUnits.length ? 'pending' : 'unanalyzed';
  const view =
    (selectedView === 'group' && !activeGroup) ||
    (selectedView === 'unanalyzed' && !unanalyzed.length)
      ? defaultView
      : (selectedView ?? defaultView);
  const unitsByCategory = new Map<GitMultiCommitCategory, GitMultiCommitUnit[]>();
  const pendingByCategory = new Map<GitMultiCommitCategory, GitMultiCommitUnit[]>();
  for (const unit of visible[view]) {
    const category = unitCategory(unit, ownerByUnit.has(unit.id));
    const candidates = unitsByCategory.get(category) ?? [];
    candidates.push(unit);
    unitsByCategory.set(category, candidates);
  }
  for (const unit of pendingUnits) {
    const category = unitCategory(unit, false);
    const candidates = pendingByCategory.get(category) ?? [];
    candidates.push(unit);
    pendingByCategory.set(category, candidates);
  }
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
        ? messages.loading
        : status === 'previewing'
          ? messages.previewing
          : messages.submitting
      : null,
    disabled ? messages.unavailable : null,
    previewBlockedReason,
    invalid ? messages.invalidPlan : null,
    groups.length === 0 ? messages.noGroups : null,
    pendingUnits.length ? messages.unassignedAction(pendingUnits.length) : null,
    unanalyzed.length ? messages.unanalyzedAction(unanalyzed.length) : null,
    ...groups.flatMap((group, index) => {
      const label = messages.groupLabel(index + 1, group.title);
      return [
        !group.title.trim() ? messages.groupIssue(label, messages.titleRequired) : null,
        group.unitIds.length === 0 ? messages.groupIssue(label, messages.emptyGroup) : null,
      ];
    }),
  ].filter((reason): reason is string => Boolean(reason));
  const focusInventoryView = (target = view) =>
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

  function moveUnit(unitId: string, value: string) {
    if (locked) return;
    const unit = units.find((candidate) => candidate.id === unitId);
    if (!unit) return;
    const target = groups.find((group) => groupValue(group.id) === value);
    if (value !== unassignedValue && value !== excludedValue && !target) return;
    if (target && unit.blockedReason !== undefined) return;
    if (
      (view === 'pending' && value !== unassignedValue) ||
      (view === 'unanalyzed' && value !== unassignedValue) ||
      (view === 'retained' && value !== excludedValue) ||
      (view === 'group' && target?.id !== activeGroup?.id)
    )
      focusInventoryView();
    const excluded = excludedUnitIds.filter((id) => id !== unitId);
    if (value === excludedValue) excluded.push(unitId);
    onGroupsChange(
      groups.map((group) => {
        const unitIds = group.unitIds.filter((id) => id !== unitId);
        if (target?.id === group.id) unitIds.push(unitId);
        return { ...group, unitIds };
      }),
      excluded,
    );
  }

  function retainCategory(category: GitMultiCommitCategory) {
    if (locked || view !== 'pending') return;
    const retained = pendingByCategory.get(category)?.filter((unit) => unit.blockedReason) ?? [];
    if (retained.length === 0) return;
    focusInventoryView();
    onGroupsChange(
      groups.map((group) => ({ ...group, unitIds: [...group.unitIds] })),
      [...excludedUnitIds, ...retained.map((unit) => unit.id)],
    );
  }

  return (
    <section
      className={cn('git-multi-commit', className)}
      aria-labelledby={fields + '-groups'}
      aria-busy={busy}
    >
      <div
        className="git-multi-commit-scroll"
        role="region"
        aria-label={messages.contentLabel}
        tabIndex={0}
      >
        {status === 'previewing' || status === 'submitting' ? (
          <p className="git-multi-commit-status" role="status">
            <LoaderCircle aria-hidden="true" />
            {status === 'previewing' ? messages.previewing : messages.submitting}
          </p>
        ) : null}
        <div className="git-multi-commit-columns">
          <section className="git-multi-commit-plan" aria-labelledby={fields + '-groups'}>
            <header className="git-multi-commit-heading">
              <h4 id={fields + '-groups'}>{messages.groups}</h4>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={locked || groups.length >= 120}
                onClick={onAddGroup}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                {messages.addGroup}
              </Button>
            </header>
            {activeGroup ? (
              <>
                <ol className="git-multi-commit-groups" aria-label={messages.activeGroup}>
                  {groups.map((group, index) => (
                    <li key={group.id}>
                      <Button
                        type="button"
                        variant={group.id === activeGroup.id ? 'secondary' : 'ghost'}
                        size="sm"
                        className="justify-between"
                        disabled={disabled || busy}
                        aria-pressed={group.id === activeGroup.id}
                        onClick={() => {
                          onActiveGroupChange(group.id);
                          setView('group');
                        }}
                      >
                        <span>
                          {messages.groupLabel(index + 1, group.title || messages.titlePlaceholder)}
                        </span>
                        <Badge variant="outline">{messages.unitCount(group.unitIds.length)}</Badge>
                      </Button>
                    </li>
                  ))}
                </ol>
                <div className="git-multi-commit-actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    disabled={locked || activeIndex === 0}
                    aria-label={messages.moveGroupUp}
                    title={messages.moveGroupUp}
                    onClick={() => moveActive(-1)}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    disabled={locked || activeIndex === groups.length - 1}
                    aria-label={messages.moveGroupDown}
                    title={messages.moveGroupDown}
                    onClick={() => moveActive(1)}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    onClick={removeActive}
                  >
                    <Trash2 data-icon="inline-start" aria-hidden="true" />
                    {messages.removeGroup}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={locked || activeIndex === 0}
                    onClick={() => mergeActive(-1)}
                    aria-describedby={fields + '-merge-hint'}
                  >
                    {messages.mergeWithPrevious}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={locked || activeIndex === groups.length - 1}
                    onClick={() => mergeActive(1)}
                    aria-describedby={fields + '-merge-hint'}
                  >
                    {messages.mergeWithNext}
                  </Button>
                </div>
                <p id={fields + '-merge-hint'} className="git-multi-commit-hint">
                  {messages.mergeHint}
                </p>
                <div
                  className="git-multi-commit-field"
                  data-disabled={locked || undefined}
                  data-invalid={!activeGroup.title.trim() || undefined}
                >
                  <label htmlFor={fields + '-title'}>{messages.title}</label>
                  <input
                    id={fields + '-title'}
                    value={activeGroup.title}
                    placeholder={messages.titlePlaceholder}
                    disabled={locked}
                    required
                    aria-invalid={!activeGroup.title.trim()}
                    aria-describedby={
                      !activeGroup.title.trim() ? fields + '-title-error' : undefined
                    }
                    onChange={(event) => updateActive({ title: event.target.value })}
                  />
                  {!activeGroup.title.trim() ? (
                    <p id={fields + '-title-error'} className="git-multi-commit-field-error">
                      {messages.titleRequired}
                    </p>
                  ) : null}
                </div>
                <div className="git-multi-commit-field" data-disabled={locked || undefined}>
                  <label htmlFor={fields + '-body'}>{messages.body}</label>
                  <textarea
                    id={fields + '-body'}
                    rows={5}
                    value={activeGroup.body}
                    placeholder={messages.bodyPlaceholder}
                    disabled={locked}
                    onChange={(event) => updateActive({ body: event.target.value })}
                  />
                </div>
                <p className="git-multi-commit-hint">{messages.removalHint}</p>
              </>
            ) : (
              <p className="git-multi-commit-hint">{messages.noGroups}</p>
            )}
          </section>
          <section className="git-multi-commit-inventory" aria-labelledby={fields + '-units'}>
            <h4 id={fields + '-units'}>{messages.units}</h4>
            <fieldset
              ref={inventoryViews}
              className="git-multi-commit-views"
              aria-controls={fields + '-inventory'}
            >
              <legend className="sr-only">{inventory.views}</legend>
              {(['group', 'pending', 'unanalyzed', 'all', 'retained'] as const)
                .filter(
                  (option) =>
                    option !== 'unanalyzed' || unanalyzed.length > 0 || view === 'unanalyzed',
                )
                .filter((option) => option !== 'group' || Boolean(activeGroup))
                .map((option) => (
                  <label key={option} className="git-multi-commit-view">
                    <input
                      type="radio"
                      name={fields + '-view'}
                      value={option}
                      checked={view === option}
                      onChange={() => setView(option)}
                    />
                    <span>{inventory[option]}</span>
                    <Badge variant="outline" aria-hidden="true">
                      {visible[option].length}
                    </Badge>
                  </label>
                ))}
            </fieldset>
            {units.length === 0 ? (
              <p className="git-multi-commit-hint">{messages.noUnits}</p>
            ) : view === 'pending' && pendingUnits.length === 0 ? (
              <p className="git-multi-commit-hint" role="status">
                {messages.noUnassigned}
              </p>
            ) : view === 'retained' && retainedCount === 0 ? (
              <p className="git-multi-commit-hint">{inventory.noRetained}</p>
            ) : null}
            <div id={fields + '-inventory'}>
              {categories.map((category) => {
                const candidates = unitsByCategory.get(category) ?? [];
                if (candidates.length === 0) return null;
                const retainable =
                  pendingByCategory.get(category)?.filter((unit) => unit.blockedReason).length ?? 0;
                const { title, reason } = inventory.categories[category];
                const expanded = expandedCategories[category] ?? candidates.length <= 20;
                const categoryId = fields + '-category-' + category;
                return (
                  <section
                    className="git-multi-commit-category"
                    key={category}
                    aria-labelledby={categoryId}
                  >
                    <header className="git-multi-commit-category-heading">
                      <h5 id={categoryId}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-expanded={expanded}
                          aria-controls={categoryId + '-items'}
                          onClick={() =>
                            setExpandedCategories((current) => ({
                              ...current,
                              [category]: !expanded,
                            }))
                          }
                        >
                          <ChevronRight data-icon="inline-start" aria-hidden="true" />
                          {title}
                          <Badge variant="outline">{messages.unitCount(candidates.length)}</Badge>
                        </Button>
                      </h5>
                      {view === 'pending' && retainable > 0 ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={locked}
                          aria-label={inventory.retainCategoryLabel(title, retainable)}
                          aria-describedby={categoryId + '-reason'}
                          onClick={() => retainCategory(category)}
                        >
                          {inventory.retainCategory}
                        </Button>
                      ) : null}
                    </header>
                    {reason && view !== 'group' ? (
                      <p id={categoryId + '-reason'} className="git-multi-commit-hint">
                        {reason}
                      </p>
                    ) : null}
                    <ul
                      id={categoryId + '-items'}
                      className="git-multi-commit-units"
                      hidden={!expanded}
                    >
                      {expanded
                        ? candidates.map((unit) => (
                            <UnitAssignmentRow
                              key={unit.id}
                              unit={unit}
                              groups={groups}
                              ownerId={ownerByUnit.get(unit.id)}
                              excluded={excludedIds.has(unit.id)}
                              layerLabelId={categoryId}
                              view={view}
                              messages={messages}
                              disabled={locked}
                              onMove={moveUnit}
                              onRestoreFocus={focusInventoryView}
                            />
                          ))
                        : null}
                    </ul>
                  </section>
                );
              })}
            </div>
          </section>
        </div>
        {previewCurrent && preview ? (
          <section className="git-multi-commit-previews" aria-labelledby={fields + '-previews'}>
            <h4 id={fields + '-previews'} ref={previewHeading} tabIndex={-1}>
              {messages.previewHeading}
            </h4>
            <p className="git-multi-commit-hint">{messages.commitNotice}</p>
            {groups.map((group, index) => (
              <section key={group.id} className="git-multi-commit-preview">
                <h5>{messages.groupLabel(index + 1, group.title)}</h5>
                <div
                  className="git-multi-commit-diff"
                  role="region"
                  tabIndex={0}
                  aria-label={messages.groupLabel(index + 1, group.title)}
                >
                  {preview.renderGroupDiff(group, index)}
                </div>
              </section>
            ))}
          </section>
        ) : null}
      </div>
      <footer className="git-multi-commit-footer">
        {confirmDisabled && blockingReasons.length > 0 ? (
          <div
            id={fields + '-blocking'}
            className="git-multi-commit-blocking"
            role="status"
            aria-live="polite"
          >
            <strong>{previewDisabled ? messages.cannotPreview : messages.cannotConfirm}</strong>
            <ul>
              {blockingReasons.slice(0, 5).map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
              {blockingReasons.length > 5 ? <li>{messages.moreIssues}</li> : null}
            </ul>
            {pendingUnits.length || unanalyzed.length ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const target = pendingUnits.length ? 'pending' : 'unanalyzed';
                  setView(target);
                  inventoryViews.current?.scrollIntoView({ block: 'nearest' });
                  focusInventoryView(target);
                }}
              >
                {pendingUnits.length ? inventory.pending : inventory.unanalyzed}
              </Button>
            ) : null}
          </div>
        ) : null}
        {onCancel ? (
          <Button
            type="button"
            variant="outline"
            disabled={status === 'submitting'}
            onClick={onCancel}
          >
            {messages.cancel}
          </Button>
        ) : null}
        <Button
          type="button"
          variant={previewCurrent ? 'outline' : 'default'}
          disabled={previewDisabled}
          aria-describedby={
            confirmDisabled && blockingReasons.length ? fields + '-blocking' : undefined
          }
          onClick={() => {
            if (!previewDisabled) onPreview();
          }}
        >
          {messages.preview}
        </Button>
        <Button
          type="button"
          variant={previewCurrent ? 'default' : 'outline'}
          disabled={confirmDisabled}
          aria-describedby={
            confirmDisabled && blockingReasons.length ? fields + '-blocking' : undefined
          }
          onClick={() => {
            if (!confirmDisabled) onConfirm();
          }}
        >
          {status === 'submitting' ? (
            <LoaderCircle data-icon="inline-start" aria-hidden="true" />
          ) : (
            <GitCommitHorizontal data-icon="inline-start" aria-hidden="true" />
          )}
          {status === 'submitting' ? messages.submitting : messages.confirm}
        </Button>
      </footer>
    </section>
  );
}

function UnitAssignmentRow({
  unit,
  groups,
  ownerId,
  excluded,
  layerLabelId,
  view,
  messages,
  disabled,
  onMove,
  onRestoreFocus,
}: {
  unit: GitMultiCommitUnit;
  groups: readonly GitMultiCommitGroup[];
  ownerId: string | undefined;
  excluded: boolean;
  layerLabelId: string;
  view: InventoryView;
  messages: GitMultiCommitEditorMessages;
  disabled: boolean;
  onMove: (unitId: string, target: string) => void;
  onRestoreFocus: () => void;
}) {
  const field = useId();
  const restoreFocus = useRef(false);
  const blocked = unit.blockedReason !== undefined;
  const ownerIndex = groups.findIndex((group) => group.id === ownerId);
  const owner = groups[ownerIndex];
  return (
    <li className="git-multi-commit-unit">
      <div className="git-multi-commit-unit-heading">
        <code id={field + '-path'}>{unit.path}</code>
        <Badge variant="outline">{messages.layers[unit.layer]}</Badge>
        {blocked ? <Badge variant="warning">{messages.blocked}</Badge> : null}
        {excluded ? (
          <Badge variant="secondary">{messages.excluded}</Badge>
        ) : view === 'all' && owner ? (
          <Badge variant="secondary">
            {messages.inventory.assignedTo(messages.groupLabel(ownerIndex + 1, owner.title))}
          </Badge>
        ) : null}
      </div>
      <p id={field + '-description'} className="git-multi-commit-hint">
        {[unit.description, unit.note].filter(Boolean).join(' · ')}
      </p>
      {blocked ? (
        <p id={field + '-blocked'} className="git-multi-commit-blocked">
          {unit.blockedReason || messages.blocked}
        </p>
      ) : null}
      <div className="git-multi-commit-field" data-disabled={disabled || undefined}>
        <label id={field + '-label'} htmlFor={field + '-target'}>
          {messages.assignment}
        </label>
        <Select
          value={
            excluded ? excludedValue : ownerId === undefined ? unassignedValue : groupValue(ownerId)
          }
          disabled={disabled}
          onValueChange={(value) => {
            restoreFocus.current =
              (view === 'pending' && value !== unassignedValue) ||
              (view === 'unanalyzed' && value !== unassignedValue) ||
              (view === 'retained' && value !== excludedValue) ||
              (view === 'group' && ownerId !== undefined && value !== groupValue(ownerId));
            onMove(unit.id, value);
          }}
        >
          <SelectTrigger
            id={field + '-target'}
            className="w-full"
            size="sm"
            aria-labelledby={field + '-path ' + layerLabelId + ' ' + field + '-label'}
            aria-describedby={field + '-description' + (blocked ? ' ' + field + '-blocked' : '')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            className="git-multi-commit-options"
            position="popper"
            onCloseAutoFocus={(event) => {
              if (restoreFocus.current) {
                event.preventDefault();
                onRestoreFocus();
                restoreFocus.current = false;
              }
            }}
          >
            <SelectGroup>
              <SelectItem value={unassignedValue}>{messages.unassigned}</SelectItem>
              <SelectItem value={excludedValue}>{messages.excluded}</SelectItem>
              {groups.map((group, index) => (
                <SelectItem key={index} value={groupValue(group.id)} disabled={blocked}>
                  <span className="git-multi-commit-option">
                    {messages.groupLabel(index + 1, group.title)}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </li>
  );
}
