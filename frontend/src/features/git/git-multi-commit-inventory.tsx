/**
 * @file 渲染多提交计划右侧候选单元清单与批量分配控件。
 * @implementation 提供分组/待分配/未分析/全部/已保留视图切换、类别折叠、逐文件及批量分配与保留操作。
 * @updated 2026-11-27T21:50:00+08:00
 */
import { Fragment, useId, useRef, useState, type RefObject } from 'react';
import { ChevronRight } from 'lucide-react';
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
import { useUiTranslation } from '@/i18n';
import {
  categories,
  excludedValue,
  groupValue,
  unassignedValue,
  unitCategory,
  type GitMultiCommitCategory,
  type GitMultiCommitGroup,
  type GitMultiCommitUnit,
  type InventoryView,
} from './git-multi-commit-types';

const categoryCopy = {
  protected: { titleKey: 'multi.category.protected', reasonKey: 'multi.category.protectedReason' },
  credentials: {
    titleKey: 'multi.category.credentials',
    reasonKey: 'multi.category.credentialsReason',
  },
  localOnly: { titleKey: 'multi.category.localOnly', reasonKey: 'multi.category.localOnlyReason' },
  dependency: {
    titleKey: 'multi.category.dependency',
    reasonKey: 'multi.category.dependencyReason',
  },
  unanalyzed: { titleKey: 'multi.view.unanalyzed', reasonKey: 'multi.category.unanalyzedReason' },
  modelUnassigned: {
    titleKey: 'multi.category.modelUnassigned',
    reasonKey: 'multi.category.modelUnassignedReason',
  },
  assigned: { titleKey: 'multi.view.group', reasonKey: null },
  conflict: { titleKey: 'multi.category.conflict', reasonKey: 'multi.category.conflictReason' },
  rename: { titleKey: 'multi.category.rename', reasonKey: 'multi.category.renameReason' },
  limits: { titleKey: 'multi.category.limits', reasonKey: 'multi.category.limitsReason' },
  index: { titleKey: 'multi.category.index', reasonKey: 'multi.category.indexReason' },
  other: { titleKey: 'multi.category.other', reasonKey: 'multi.category.otherReason' },
  unassigned: {
    titleKey: 'multi.category.unassigned',
    reasonKey: 'multi.category.unassignedReason',
  },
} as const satisfies Record<GitMultiCommitCategory, { titleKey: string; reasonKey: string | null }>;

const viewLabelKeys = {
  group: 'multi.view.group',
  pending: 'multi.view.pending',
  unanalyzed: 'multi.view.unanalyzed',
  all: 'multi.view.all',
  retained: 'multi.view.retained',
} as const satisfies Record<InventoryView, string>;

const layerLabelKeys = {
  staged: 'layer.staged',
  unstaged: 'layer.unstaged',
  untracked: 'layer.untracked',
  conflict: 'layer.conflict',
} as const;

export function GitMultiCommitInventory({
  fieldsPrefix,
  inventoryViewsRef,
  units,
  groups,
  activeGroup,
  ownerByUnit,
  excludedIds,
  view,
  visible,
  pendingUnits,
  unanalyzed,
  retainedCount,
  selectedIds,
  locked,
  onViewChange,
  onSelectUnits,
  onClearSelection,
  onMoveUnits,
  onRestoreFocus,
}: {
  fieldsPrefix: string;
  inventoryViewsRef: RefObject<HTMLFieldSetElement | null>;
  units: readonly GitMultiCommitUnit[];
  groups: readonly GitMultiCommitGroup[];
  activeGroup: GitMultiCommitGroup | undefined;
  ownerByUnit: ReadonlyMap<string, string>;
  excludedIds: ReadonlySet<string>;
  view: InventoryView;
  visible: Readonly<Record<InventoryView, readonly GitMultiCommitUnit[]>>;
  pendingUnits: readonly GitMultiCommitUnit[];
  unanalyzed: readonly GitMultiCommitUnit[];
  retainedCount: number;
  selectedIds: ReadonlySet<string>;
  locked: boolean;
  onViewChange: (view: InventoryView) => void;
  onSelectUnits: (candidates: readonly GitMultiCommitUnit[], checked: boolean) => void;
  onClearSelection: () => void;
  onMoveUnits: (ids: readonly string[], target: string) => void;
  onRestoreFocus: () => void;
}) {
  const { t } = useUiTranslation('git');
  const [destination, setDestination] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<
    Partial<Record<GitMultiCommitCategory, boolean>>
  >({});

  const selection = pendingUnits.filter((unit) => selectedIds.has(unit.id));
  const canAssignBatch = selection.every((unit) => unit.blockedReason === undefined);
  const batchTarget =
    destination === excludedValue ||
    (canAssignBatch && groups.some((group) => groupValue(group.id) === destination))
      ? destination
      : '';

  const unitsByCategory = new Map<GitMultiCommitCategory, GitMultiCommitUnit[]>();
  for (const unit of visible[view]) {
    const category = unitCategory(unit, ownerByUnit.has(unit.id));
    const candidates = unitsByCategory.get(category) ?? [];
    candidates.push(unit);
    unitsByCategory.set(category, candidates);
  }

  return (
    <section className="git-multi-commit-inventory" aria-labelledby={fieldsPrefix + '-units'}>
      <h4 id={fieldsPrefix + '-units'}>{t('multi.units')}</h4>
      <fieldset
        ref={inventoryViewsRef}
        className="git-multi-commit-views"
        aria-controls={fieldsPrefix + '-inventory'}
      >
        <legend className="sr-only">{t('multi.views')}</legend>
        {(['group', 'pending', 'unanalyzed', 'all', 'retained'] as const)
          .filter(
            (option) => option !== 'unanalyzed' || unanalyzed.length > 0 || view === 'unanalyzed',
          )
          .filter((option) => option !== 'group' || Boolean(activeGroup))
          .map((option) => (
            <label key={option} className="git-multi-commit-view">
              <input
                type="radio"
                name={fieldsPrefix + '-view'}
                value={option}
                checked={view === option}
                onChange={() => onViewChange(option)}
              />
              <span>{t(viewLabelKeys[option])}</span>
              <Badge variant="outline" aria-hidden="true">
                {visible[option].length}
              </Badge>
            </label>
          ))}
      </fieldset>
      {view === 'pending' && pendingUnits.length > 1 ? (
        <BatchCheckbox
          label={t('multi.batch.all')}
          candidates={pendingUnits}
          selectedIds={selectedIds}
          disabled={locked}
          onSelect={onSelectUnits}
        />
      ) : null}
      {view === 'pending' && selection.length ? (
        <div className="git-multi-commit-batch">
          <p role="status">{t('multi.batch.selected', { count: selection.length })}</p>
          <div>
            <Select value={batchTarget} onValueChange={setDestination} disabled={locked}>
              <SelectTrigger aria-label={t('multi.batch.destination')} size="sm">
                <SelectValue placeholder={t('multi.batch.destination')} />
              </SelectTrigger>
              <SelectContent position="popper" className="git-multi-commit-options">
                <SelectGroup>
                  <SelectItem value={excludedValue}>{t('multi.excluded')}</SelectItem>
                  {groups.map((group, index) => (
                    <SelectItem
                      key={group.id}
                      value={groupValue(group.id)}
                      disabled={!canAssignBatch}
                    >
                      {t('multi.groupLabel', {
                        number: index + 1,
                        title: group.title || t('commit.titlePlaceholder'),
                      })}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              disabled={locked || !batchTarget}
              onClick={() => {
                onMoveUnits(
                  selection.map(({ id }) => id),
                  batchTarget,
                );
                setDestination('');
              }}
            >
              {t('multi.batch.apply')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={locked}
              onClick={() => {
                onRestoreFocus();
                onClearSelection();
                setDestination('');
              }}
            >
              {t('multi.batch.clear')}
            </Button>
          </div>
          {!canAssignBatch ? (
            <p className="git-multi-commit-hint">{t('multi.batch.blocked')}</p>
          ) : null}
        </div>
      ) : null}
      {units.length === 0 ? (
        <p className="git-multi-commit-hint">{t('multi.noUnits')}</p>
      ) : view === 'pending' && pendingUnits.length === 0 ? (
        <p className="git-multi-commit-hint" role="status">
          {t('multi.noUnassigned')}
        </p>
      ) : view === 'retained' && retainedCount === 0 ? (
        <p className="git-multi-commit-hint">{t('multi.noRetained')}</p>
      ) : null}
      <div id={fieldsPrefix + '-inventory'}>
        {categories.map((category) => {
          const candidates = unitsByCategory.get(category) ?? [];
          if (candidates.length === 0) return null;
          const selecting = view === 'pending';
          const retainable = selecting ? candidates.filter((unit) => unit.blockedReason) : [];
          const { titleKey, reasonKey } = categoryCopy[category];
          const title = t(titleKey);
          const reason = reasonKey ? t(reasonKey) : '';
          const expanded = expandedCategories[category] ?? candidates.length <= 20;
          const categoryId = fieldsPrefix + '-category-' + category;
          const byPath = new Map<string, GitMultiCommitUnit[]>();
          if (selecting && expanded) {
            for (const unit of candidates) {
              const samePath = byPath.get(unit.path) ?? [];
              samePath.push(unit);
              byPath.set(unit.path, samePath);
            }
          }
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
                    <Badge variant="outline">
                      {t('multi.unitCount', { count: candidates.length })}
                    </Badge>
                  </Button>
                </h5>
                {selecting ? (
                  <BatchCheckbox
                    label={t('multi.batch.category', { category: title })}
                    candidates={candidates}
                    selectedIds={selectedIds}
                    disabled={locked}
                    onSelect={onSelectUnits}
                  />
                ) : null}
                {retainable.length ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={locked}
                    aria-label={t('multi.retainCategoryLabel', {
                      category: title,
                      count: retainable.length,
                    })}
                    aria-describedby={categoryId + '-reason'}
                    onClick={() =>
                      onMoveUnits(
                        retainable.map(({ id }) => id),
                        excludedValue,
                      )
                    }
                  >
                    {t('multi.retainCategory')}
                  </Button>
                ) : null}
              </header>
              {reason && view !== 'group' ? (
                <p id={categoryId + '-reason'} className="git-multi-commit-hint">
                  {reason}
                </p>
              ) : null}
              <ul id={categoryId + '-items'} className="git-multi-commit-units" hidden={!expanded}>
                {expanded
                  ? (selecting ? [...byPath.values()] : [candidates]).map((fileUnits) => (
                      <Fragment key={fileUnits[0]?.id}>
                        {selecting && fileUnits.length > 1 && fileUnits[0] ? (
                          <li className="git-multi-commit-file-select">
                            <BatchCheckbox
                              label={t('multi.batch.file', { path: fileUnits[0].path })}
                              candidates={fileUnits}
                              selectedIds={selectedIds}
                              disabled={locked}
                              onSelect={onSelectUnits}
                            />
                          </li>
                        ) : null}
                        {fileUnits.map((unit) => (
                          <UnitAssignmentRow
                            key={unit.id}
                            unit={unit}
                            groups={groups}
                            ownerId={ownerByUnit.get(unit.id)}
                            excluded={excludedIds.has(unit.id)}
                            layerLabelId={categoryId}
                            view={view}
                            disabled={locked}
                            selected={selectedIds.has(unit.id)}
                            onSelect={onSelectUnits}
                            onMove={(id, value) => onMoveUnits([id], value)}
                            onRestoreFocus={onRestoreFocus}
                          />
                        ))}
                      </Fragment>
                    ))
                  : null}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function BatchCheckbox({
  label,
  candidates,
  selectedIds,
  disabled,
  onSelect,
}: {
  label: string;
  candidates: readonly GitMultiCommitUnit[];
  selectedIds: ReadonlySet<string>;
  disabled: boolean;
  onSelect: (candidates: readonly GitMultiCommitUnit[], checked: boolean) => void;
}) {
  const count = candidates.filter(({ id }) => selectedIds.has(id)).length;
  return (
    <label className="git-multi-commit-selection">
      <input
        type="checkbox"
        ref={(input) => {
          if (input) input.indeterminate = count > 0 && count < candidates.length;
        }}
        checked={count === candidates.length}
        disabled={disabled}
        onChange={(event) => onSelect(candidates, event.target.checked)}
      />
      {label}
    </label>
  );
}

function UnitAssignmentRow({
  unit,
  groups,
  ownerId,
  excluded,
  layerLabelId,
  view,
  disabled,
  selected,
  onSelect,
  onMove,
  onRestoreFocus,
}: {
  unit: GitMultiCommitUnit;
  groups: readonly GitMultiCommitGroup[];
  ownerId: string | undefined;
  excluded: boolean;
  layerLabelId: string;
  view: InventoryView;
  disabled: boolean;
  selected: boolean;
  onSelect: (candidates: readonly GitMultiCommitUnit[], checked: boolean) => void;
  onMove: (unitId: string, target: string) => void;
  onRestoreFocus: () => void;
}) {
  const { t } = useUiTranslation('git');
  const field = useId();
  const restoreFocus = useRef(false);
  const blocked = unit.blockedReason !== undefined;
  const ownerIndex = groups.findIndex((group) => group.id === ownerId);
  const owner = groups[ownerIndex];
  return (
    <li className="git-multi-commit-unit">
      <div className="git-multi-commit-unit-heading">
        {view === 'pending' ? (
          <input
            type="checkbox"
            className="git-multi-commit-unit-select"
            aria-label={t('multi.batch.unit', {
              path: unit.path,
              layer: t(layerLabelKeys[unit.layer]),
              change: unit.description,
            })}
            checked={selected}
            disabled={disabled}
            onChange={(event) => onSelect([unit], event.target.checked)}
          />
        ) : null}
        <code id={field + '-path'}>{unit.path}</code>
        <Badge variant="outline">{t(layerLabelKeys[unit.layer])}</Badge>
        {blocked ? <Badge variant="warning">{t('multi.blocked')}</Badge> : null}
        {excluded ? (
          <Badge variant="secondary">{t('multi.excluded')}</Badge>
        ) : view === 'all' && owner ? (
          <Badge variant="secondary">
            {t('multi.assignedTo', {
              group: t('multi.groupLabel', { number: ownerIndex + 1, title: owner.title }),
            })}
          </Badge>
        ) : null}
      </div>
      <p id={field + '-description'} className="git-multi-commit-hint">
        {[unit.description, unit.note].filter(Boolean).join(' · ')}
      </p>
      {blocked ? (
        <p id={field + '-blocked'} className="git-multi-commit-blocked">
          {unit.blockedReason || t('multi.blocked')}
        </p>
      ) : null}
      <div className="git-multi-commit-field" data-disabled={disabled || undefined}>
        <label id={field + '-label'} htmlFor={field + '-target'}>
          {t('multi.assignment')}
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
              <SelectItem value={unassignedValue}>{t('multi.unassigned')}</SelectItem>
              <SelectItem value={excludedValue}>{t('multi.excluded')}</SelectItem>
              {groups.map((group, index) => (
                <SelectItem key={index} value={groupValue(group.id)} disabled={blocked}>
                  <span className="git-multi-commit-option">
                    {t('multi.groupLabel', { number: index + 1, title: group.title })}
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
