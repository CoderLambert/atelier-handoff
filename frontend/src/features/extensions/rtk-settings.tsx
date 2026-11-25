/**
 * @file 展示项目 Hooks 页中的内置 RTK 开关。
 * @implementation 查询运行时能力和继承来源，提供可逆的全局默认与项目覆盖，并显示本地化保存与错误反馈。
 * @updated 2026-11-26T01:39:35+08:00
 */
import { useId } from 'react';
import { useUiTranslation } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useRtkSettings } from '@/use-query/rtk-settings/use-rtk-settings';
import { useUpdateRtkSettings } from '@/use-query/rtk-settings/use-update-rtk-settings';
import { rtkProjectModeSchema } from '@shared/rtk-settings';

export function RtkHookSettings({ projectId }: { projectId?: string }) {
  const { t } = useUiTranslation('extensions');
  const id = useId();
  const query = useRtkSettings(projectId);
  const update = useUpdateRtkSettings(projectId);
  const globalUpdate = useUpdateRtkSettings();
  const view = query.data;
  const disabled = update.saving || globalUpdate.saving || query.isError;
  const saveError = update.error || globalUpdate.error;
  const modes = [
    { value: 'follow', label: t('hooks.follow') },
    { value: 'on', label: t('hooks.on') },
    { value: 'off', label: t('hooks.off') },
  ] as const;
  return (
    <section
      className="flex max-w-4xl flex-col gap-6 py-6"
      aria-labelledby={`${id}-title`}
      aria-busy={query.isFetching}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2 id={`${id}-title`} className="text-base font-semibold">
          {t('hooks.rtkTitle')}
        </h2>
        <Badge variant="outline">{t('hooks.builtin')}</Badge>
        {view ? (
          <Badge
            variant={!view.available ? 'warning' : view.effectiveEnabled ? 'success' : 'secondary'}
          >
            {t(
              !view.available
                ? 'hooks.unavailable'
                : view.effectiveEnabled
                  ? 'common.enabled'
                  : 'common.disabled',
            )}
          </Badge>
        ) : null}
      </header>
      <p className="text-sm text-muted-foreground">{t('hooks.description')}</p>
      {query.isPending ? <p role="status">{t('hooks.loading')}</p> : null}
      {query.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive" role="alert">
            {t('hooks.loadFailed')}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {t('common.reload')}
          </Button>
        </div>
      ) : null}
      {view ? (
        <>
          {view.unavailableReason ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t(
                view.unavailableReason === 'native-unavailable'
                  ? 'hooks.nativeUnavailable'
                  : 'hooks.resourceUnavailable',
              )}
            </p>
          ) : null}
          <fieldset className="flex flex-col gap-5" disabled={disabled}>
            <legend className="sr-only">{t('hooks.settingsLabel')}</legend>
            {projectId ? (
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <label
                    id={`${id}-project-label`}
                    htmlFor={`${id}-project`}
                    className="text-sm font-medium"
                  >
                    {t('hooks.projectLabel')}
                  </label>
                  <p id={`${id}-source`} className="text-sm text-muted-foreground">
                    {t(
                      view.source === 'project'
                        ? 'hooks.sourceProject'
                        : view.globalEnabled
                          ? 'hooks.sourceGlobalOn'
                          : 'hooks.sourceGlobalOff',
                    )}
                  </p>
                </div>
                <Select
                  value={view.projectMode}
                  disabled={disabled}
                  onValueChange={(value) => {
                    const result = rtkProjectModeSchema.safeParse(value);
                    if (result.success && result.data !== view.projectMode)
                      update.save({ type: 'project', mode: result.data });
                  }}
                >
                  <SelectTrigger
                    id={`${id}-project`}
                    aria-labelledby={`${id}-project-label`}
                    aria-describedby={`${id}-source`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="end">
                    <SelectGroup>
                      {modes.map(({ value, label }) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-global`} className="text-sm font-medium">
                  {t('hooks.globalLabel')}
                </label>
                <p id={`${id}-global-help`} className="text-sm text-muted-foreground">
                  {t('hooks.globalHelp')}
                </p>
              </div>
              <Switch
                id={`${id}-global`}
                checked={view.globalEnabled}
                disabled={disabled}
                aria-describedby={`${id}-global-help`}
                onCheckedChange={(enabled) => globalUpdate.save({ type: 'global', enabled })}
              />
            </div>
          </fieldset>
          <p className="text-sm text-muted-foreground">{t('hooks.applyHelp')}</p>
          <p className="text-sm text-muted-foreground">{t('hooks.bypassHelp')}</p>
        </>
      ) : null}
      {update.saving || globalUpdate.saving ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t('common.saving')}
        </p>
      ) : null}
      {saveError ? (
        <p className="text-sm text-destructive" role="alert">
          {t('hooks.saveFailed')}
        </p>
      ) : null}
    </section>
  );
}
