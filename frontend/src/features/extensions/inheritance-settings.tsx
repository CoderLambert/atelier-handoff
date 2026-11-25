/**
 * @file 提供全局和项目级 Skill 继承设置。
 * @implementation 查询并更新本机 Skill 策略和项目继承方式，展示搜索、可用状态及保存反馈。
 * @updated 2026-11-26T00:06:59+08:00
 */
import { useId, useState } from 'react';
import { useUiTranslation } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useSkillInheritance } from '@/use-query/skill-inheritance/use-skill-inheritance';
import { useUpdateSkillInheritance } from '@/use-query/skill-inheritance/use-update-skill-inheritance';
import type { SkillInheritanceScope } from '@/use-query/skill-inheritance/keys';
import {
  policies,
  SkillAvailability,
  SkillAvailabilityFeedback,
  SkillIdentity,
  SkillPolicySelect,
} from './inheritance-controls';
import './inheritance.css';

export function GlobalSkillInheritance() {
  const { t } = useUiTranslation('extensions');
  const id = useId();
  const [search, setSearch] = useState('');
  const scope = { type: 'global' } as const;
  const query = useSkillInheritance(scope);
  const update = useUpdateSkillInheritance(scope);
  const view = query.data;
  const items = view?.items.filter(({ source }) => source === 'host') ?? [];
  const term = search.trim().toLocaleLowerCase();
  const visible = items.filter(({ name, description }) =>
    `${name} ${description}`.toLocaleLowerCase().includes(term),
  );
  return (
    <div className="skill-inheritance-view">
      <div className="skill-inheritance-panel">
        <div className="skill-inheritance-heading">
          <div>
            <h2 id={`${id}-title`} className="text-base font-semibold">{t('inheritance.globalTitle')}</h2>
            <p id={`${id}-help`} className="text-sm text-muted-foreground">{t('inheritance.globalHelp')}</p>
          </div>
          {view ? (
            <div className="flex items-center gap-2">
              <Badge variant={view.enabled ? 'success' : 'secondary'}>
                {t(view.enabled ? 'common.enabled' : 'common.disabled')}
              </Badge>
              <Switch
                checked={view.enabled}
                aria-labelledby={`${id}-title`}
                aria-describedby={`${id}-help`}
                disabled={update.saving || query.isError}
                onCheckedChange={(enabled) => update.save({ type: 'global', enabled })}
              />
            </div>
          ) : null}
        </div>
        <code className="text-xs text-muted-foreground">{t('inheritance.hostPath')}</code>
      </div>
      <SkillAvailabilityFeedback
        error={query.isError} loading={query.isPending} fetching={query.isFetching}
        reload={() => void query.refetch()} saveError={update.error} saving={update.saving}
      />
      {view ? (
        <section className="skill-inheritance-view" aria-labelledby={`${id}-catalog`}>
          <div className="skill-inheritance-heading">
            <h2 id={`${id}-catalog`} className="text-base font-semibold">{t('inheritance.hostCatalog')}</h2>
            {items.length ? (
              <input
                type="search"
                className="h-8 w-64 max-w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                aria-label={t('inheritance.hostSearch')}
                placeholder={t('extensions.searchPlaceholder')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            ) : null}
          </div>
          {visible.length ? (
            <ul className="skill-inheritance-list">
              {visible.map((item) => (
                <li className="skill-inheritance-row skill-inheritance-global-row" key={item.id}>
                  <SkillIdentity item={item} />
                  <SkillAvailability item={item} />
                  <div className="grid items-start gap-1.5">
                    <SkillPolicySelect
                      value={item.mode}
                      label={t('inheritance.hostPolicy', { name: item.name })}
                      disabled={update.saving || query.isError}
                      options={[
                        { value: 'off', label: t(policies.off) },
                        { value: 'manual', label: t(policies.manual), disabled: !item.manual },
                        { value: 'auto', label: t(policies.auto), disabled: !item.auto },
                      ]}
                      onChange={(mode) => update.save({ type: 'host', id: item.id, mode })}
                    />
                    {!item.manual ? <p className="text-xs text-muted-foreground">{t('extensions.manualUnsupported')}</p> : null}
                    {!item.auto ? <p className="text-xs text-muted-foreground">{t('inheritance.autoUnavailable')}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t(items.length ? 'extensions.noMatches' : 'inheritance.noHostSkills')}</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

export function ProjectSkillInheritance({ projectId }: { projectId: string }) {
  const { t } = useUiTranslation('extensions');
  const id = useId();
  const scope: SkillInheritanceScope = { type: 'project', projectId };
  const query = useSkillInheritance(scope);
  const update = useUpdateSkillInheritance(scope);
  const view = query.data;
  const workspace = view?.items.filter(({ source }) => source === 'workspace') ?? [];
  return (
    <section className="skill-inheritance-view skill-inheritance-project" aria-labelledby={id}>
      <div className="skill-inheritance-panel">
        <div className="skill-inheritance-heading">
          <div>
            <h2 id={id} className="text-base font-semibold">{t('inheritance.projectTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('inheritance.projectHelp')}</p>
          </div>
          {view ? (
            <div className="flex flex-wrap items-center gap-2">
              <SkillPolicySelect
                value={view.projectMode}
                label={t('inheritance.projectTitle')}
                options={[
                  { value: 'follow', label: t('inheritance.projectFollow') },
                  { value: 'block', label: t('inheritance.projectBlock') },
                ]}
                disabled={update.saving || query.isError}
                onChange={(mode) => update.save({ type: 'project', mode })}
              />
              {view.projectMode === 'follow' && !view.enabled ? (
                <Badge variant="secondary">{t('inheritance.reasonGlobalOff')}</Badge>
              ) : null}
            </div>
          ) : null}
        </div>
        <SkillAvailabilityFeedback
          error={query.isError} loading={query.isPending} fetching={query.isFetching}
          reload={() => void query.refetch()} saveError={update.error} saving={update.saving}
        />
      </div>
      {workspace.length ? (
        <div className="skill-inheritance-view">
          <div>
            <h3 className="text-sm font-semibold">{t('inheritance.sourceWorkspace')}</h3>
            <p className="text-sm text-muted-foreground">{t('inheritance.workspaceHelp')}</p>
          </div>
          <ul className="skill-inheritance-list">
            {workspace.map((item) => (
              <li className="skill-inheritance-row" key={item.id}>
                <SkillIdentity item={item} />
                <Badge variant="outline">{t(policies[item.mode])}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
