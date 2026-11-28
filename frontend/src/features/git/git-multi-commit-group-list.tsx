/**
 * @file 渲染多提交计划左侧分组列表与当前分组提交信息编辑栏。
 * @implementation 支持新增、排序、合并与删除提交组，并直接调用 git i18n 词条校验标题和描述。
 * @updated 2026-11-27T21:50:00+08:00
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import { MAX_MULTI_COMMIT_GROUPS } from '@shared/git-multi-commit';
import type { GitMultiCommitGroup } from './git-multi-commit-types';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export function GitMultiCommitGroupList({
  fieldsPrefix,
  groups,
  activeIndex,
  activeGroup,
  busy,
  disabled,
  locked,
  onAddGroup,
  onSelectGroup,
  onUpdateActive,
  onMoveActive,
  onMergeActive,
  onRemoveActive,
}: {
  fieldsPrefix: string;
  groups: readonly GitMultiCommitGroup[];
  activeIndex: number;
  activeGroup: GitMultiCommitGroup | undefined;
  busy: boolean;
  disabled: boolean;
  locked: boolean;
  onAddGroup: () => void;
  onSelectGroup: (groupId: string) => void;
  onUpdateActive: (patch: Partial<Pick<GitMultiCommitGroup, 'title' | 'body'>>) => void;
  onMoveActive: (offset: -1 | 1) => void;
  onMergeActive: (offset: -1 | 1) => void;
  onRemoveActive: () => void;
}) {
  const { t } = useUiTranslation('git');
  return (
    <section className="git-multi-commit-plan" aria-labelledby={fieldsPrefix + '-groups'}>
      <header className="git-multi-commit-heading">
        <h4 id={fieldsPrefix + '-groups'}>{t('multi.groups')}</h4>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={locked || groups.length >= MAX_MULTI_COMMIT_GROUPS}
          onClick={onAddGroup}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          {t('multi.addGroup')}
        </Button>
      </header>
      {activeGroup ? (
        <>
          <ol className="git-multi-commit-groups" aria-label={t('multi.activeGroup')}>
            {groups.map((group, index) => (
              <li key={group.id}>
                <Button
                  type="button"
                  variant={group.id === activeGroup.id ? 'secondary' : 'ghost'}
                  size="sm"
                  className="justify-between"
                  disabled={disabled || busy}
                  aria-pressed={group.id === activeGroup.id}
                  onClick={() => onSelectGroup(group.id)}
                >
                  <span>
                    {t('multi.groupLabel', {
                      number: index + 1,
                      title: group.title || t('commit.titlePlaceholder'),
                    })}
                  </span>
                  <Badge variant="outline">
                    {t('multi.unitCount', { count: group.unitIds.length })}
                  </Badge>
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
              aria-label={t('multi.moveUp')}
              title={t('multi.moveUp')}
              onClick={() => onMoveActive(-1)}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              disabled={locked || activeIndex === groups.length - 1}
              aria-label={t('multi.moveDown')}
              title={t('multi.moveDown')}
              onClick={() => onMoveActive(1)}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={onRemoveActive}
            >
              <Trash2 data-icon="inline-start" aria-hidden="true" />
              {t('multi.removeGroup')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={locked || activeIndex === 0}
              onClick={() => onMergeActive(-1)}
              aria-describedby={fieldsPrefix + '-merge-hint'}
            >
              {t('multi.mergePrevious')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={locked || activeIndex === groups.length - 1}
              onClick={() => onMergeActive(1)}
              aria-describedby={fieldsPrefix + '-merge-hint'}
            >
              {t('multi.mergeNext')}
            </Button>
          </div>
          <p id={fieldsPrefix + '-merge-hint'} className="git-multi-commit-hint">
            {t('multi.mergeHint')}
          </p>
          <div
            className="git-multi-commit-field"
            data-disabled={locked || undefined}
            data-invalid={!activeGroup.title.trim() || undefined}
          >
            <label htmlFor={fieldsPrefix + '-title'}>{t('commit.title')}</label>
            <Input
              id={fieldsPrefix + '-title'}
              value={activeGroup.title}
              placeholder={t('commit.titlePlaceholder')}
              disabled={locked}
              required
              aria-invalid={!activeGroup.title.trim()}
              aria-describedby={
                !activeGroup.title.trim() ? fieldsPrefix + '-title-error' : undefined
              }
              onChange={(event) => onUpdateActive({ title: event.target.value })}
            />
            {!activeGroup.title.trim() ? (
              <p id={fieldsPrefix + '-title-error'} className="git-multi-commit-field-error">
                {t('multi.titleRequired')}
              </p>
            ) : null}
          </div>
          <div className="git-multi-commit-field" data-disabled={locked || undefined}>
            <label htmlFor={fieldsPrefix + '-body'}>{t('commit.body')}</label>
            <Textarea
              id={fieldsPrefix + '-body'}
              rows={5}
              value={activeGroup.body}
              placeholder={t('commit.bodyPlaceholder')}
              disabled={locked}
              onChange={(event) => onUpdateActive({ body: event.target.value })}
            />
          </div>
          <p className="git-multi-commit-hint">{t('multi.removalHint')}</p>
        </>
      ) : (
        <p className="git-multi-commit-hint">{t('multi.noGroups')}</p>
      )}
    </section>
  );
}
