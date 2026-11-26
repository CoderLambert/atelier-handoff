/**
 * @file 提供会话 Skill 限制和草稿选择界面。
 * @implementation 展示可用性、当前运行记录及失效选择，并提供会话策略和草稿增删操作。
 * @updated 2026-11-26T00:06:59+08:00
 */
import { useRef } from 'react';
import { Sparkles, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useUiTranslation } from '@/i18n';
import type { Run } from '@shared/types';
import {
  policies,
  SkillAvailability,
  SkillAvailabilityFeedback,
  SkillIdentity,
  SkillPolicySelect,
  skillSources,
} from './inheritance-controls';
import {
  canRestrictSkill,
  canSelectSkill,
  draftSelectionLimit,
  isCurrentSkillSelection,
  recordedOnRun,
} from './inheritance-model';
import type { useSessionSkills } from './use-session-skills';
import './inheritance.css';

type SessionSkills = ReturnType<typeof useSessionSkills>;

export function SessionSkillsControl({
  skills,
  activeRun,
  disabled,
  selectionCount,
}: {
  skills: SessionSkills;
  activeRun?: Run;
  disabled: boolean;
  selectionCount: number;
}) {
  const { t } = useUiTranslation('extensions');
  const title = useRef<HTMLHeadingElement>(null);
  const { query, update, items } = skills;
  const controlsDisabled = disabled || update.saving || !query.isSuccess || query.isFetching;
  const selectionLimit = selectionCount >= draftSelectionLimit;
  const available = items.filter(({ effective }) => effective !== 'off').length;
  return (
    <Dialog open={skills.open} onOpenChange={skills.setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="composer-action-btn" disabled={disabled}>
          <Sparkles data-icon="inline-start" aria-hidden="true" />
          {t('inheritance.sessionTitle')}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="skill-inheritance-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle ref={title} tabIndex={-1}>{t('inheritance.sessionTitle')}</DialogTitle>
          <DialogDescription>{t('inheritance.sessionDescription')}</DialogDescription>
        </DialogHeader>
        <div className="skill-inheritance-dialog-body">
          {activeRun ? <p className="text-sm text-muted-foreground">{t('inheritance.activeRun')}</p> : null}
          <SkillAvailabilityFeedback
            error={query.isError} loading={query.isPending} fetching={query.isFetching}
            reload={() => void query.refetch()} saveError={update.error} saving={update.saving}
          />
          {query.isSuccess ? (
            <>
              <p className="text-sm font-medium">{t('inheritance.availableCount', { count: available })}</p>
              {items.length ? (
                <ul className="skill-inheritance-list">
                  {items.map((item) => {
                    const selection = skills.draftSkills.find(({ id }) => id === item.id);
                    const names = { name: item.name, source: t(skillSources[item.source]) };
                    return (
                      <li className="skill-inheritance-row skill-inheritance-session-row" key={item.id}>
                        <div className="grid gap-2">
                          <SkillIdentity item={item} />
                          {recordedOnRun(item, activeRun?.extensions) ? (
                            <Badge variant="info">{t('inheritance.recordedOnRun')}</Badge>
                          ) : null}
                        </div>
                        <SkillAvailability item={item} />
                        <div className="grid justify-items-start gap-2">
                          <SkillPolicySelect
                            value={item.override}
                            label={t('inheritance.sessionPolicy', names)}
                            disabled={controlsDisabled || !canRestrictSkill(item)}
                            options={[
                              { value: 'follow', label: t('inheritance.sessionFollow') },
                              { value: 'off', label: t(policies.off) },
                              ...(item.mode === 'auto' || item.override === 'manual'
                                ? [{ value: 'manual' as const, label: t(policies.manual), disabled: !item.manual }]
                                : []),
                            ]}
                            onChange={(mode) => update.save({ type: 'session', id: item.id, mode })}
                          />
                          {selection ? (
                            <>
                              <p className="text-xs text-muted-foreground" role="status">
                                {t(isCurrentSkillSelection(selection, item) ? 'inheritance.draftSelected' : 'inheritance.draftStale')}
                              </p>
                              <Button type="button" variant="ghost" size="sm" disabled={disabled}
                                aria-label={t('inheritance.removeFromDraftLabel', names)}
                                onClick={() => skills.remove(item.id)}>
                                {t('inheritance.removeFromDraft')}
                              </Button>
                            </>
                          ) : canSelectSkill(item) ? (
                            <Button type="button" variant="outline" size="sm" disabled={controlsDisabled || selectionLimit}
                              aria-label={t('inheritance.addToDraftLabel', names)}
                              onClick={() => skills.add(item.id)}>
                              {t('inheritance.addToDraft')}
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="text-sm text-muted-foreground">{t('inheritance.sessionEmpty')}</p>}
              {skills.missing.length ? (
                <div className="grid gap-2">
                  <h3 className="text-sm font-semibold">{t('inheritance.missingSelections')}</h3>
                  <ul className="skill-inheritance-list">
                    {skills.missing.map(({ id }) => (
                      <li key={id} className="skill-inheritance-row">
                        <div className="skill-inheritance-identity">
                          <code className="text-xs">{id}</code>
                          <p className="text-xs text-muted-foreground">{t('inheritance.draftStale')}</p>
                        </div>
                        <Button type="button" variant="ghost" size="sm" disabled={disabled}
                          aria-label={t('inheritance.removeMissing', { id })}
                          onClick={() => skills.remove(id)}>
                          {t('inheritance.removeFromDraft')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {selectionLimit ? (
                <p className="text-sm text-muted-foreground">
                  {t('inheritance.selectionLimit', { count: draftSelectionLimit })}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm">{t('common.close')}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DraftSessionSkills({ skills, disabled }: { skills: SessionSkills; disabled: boolean }) {
  const { t } = useUiTranslation('extensions');
  if (!skills.draftSkills.length) return null;
  return (
    <div className="ext-chips" aria-label={t('inheritance.draftSkills')}>
      {skills.draftSkills.map((selection) => {
        const item = skills.byId.get(selection.id);
        if (!item) return null;
        const names = { name: item.name, source: t(skillSources[item.source]) };
        const stale = !isCurrentSkillSelection(selection, item);
        return (
          <Badge key={item.id} variant={stale ? 'warning' : 'secondary'}>
            <span className="min-w-0">
              <strong>{item.name}</strong> · {names.source}
              {stale ? <small className="block">{t('inheritance.draftStale')}</small> : null}
            </span>
            <Button type="button" variant="ghost" size="icon-xs" disabled={disabled}
              aria-label={t('inheritance.removeFromDraftLabel', names)}
              onClick={() => skills.remove(item.id)}>
              <X aria-hidden="true" />
            </Button>
          </Badge>
        );
      })}
    </div>
  );
}
