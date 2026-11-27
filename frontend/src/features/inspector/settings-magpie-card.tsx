/**
 * @file 提供即点即存的 Magpie 网关接入开关卡片组件。
 * @implementation 在草稿表单外部独立发起配置更新并展示保存中、失败与不可用状态，避免锁定其他设置区域。
 * @updated 2026-11-27T22:20:00+08:00
 */
import { useId, useRef } from 'react';
import { Switch } from '@/components/ui/switch';
import { useUiTranslation } from '@/i18n';
import { useUpdateAppConfig } from '@/use-query/settings/use-update-app-config';
import { errorMessage } from './shared';

export function MagpieToggleCard({
  magpieEnabled,
  magpieUnavailable,
}: {
  magpieEnabled: boolean;
  magpieUnavailable: boolean;
}) {
  const { t } = useUiTranslation('inspector');
  const id = useId();
  const magpieMutation = useUpdateAppConfig();
  const lock = useRef(false);

  async function toggleMagpie(enabled: boolean) {
    if (lock.current) return;
    lock.current = true;
    try {
      await magpieMutation.mutateAsync({ magpieEnabled: enabled });
    } catch {
      // Keep the switch on its last saved value and show the mutation error.
    } finally {
      lock.current = false;
    }
  }

  return (
    <fieldset className="settings-form-section" disabled={magpieMutation.isPending}>
      <legend>Magpie</legend>
      <div className="settings-execution-toggle">
        <div className="settings-field-copy">
          <label htmlFor={id}>{t('settings.magpieEnable')}</label>
          <p id={`${id}-help`}>{t('settings.magpieHint')}</p>
        </div>
        <Switch
          id={id}
          className="settings-switch"
          checked={magpieEnabled}
          disabled={magpieMutation.isPending}
          aria-describedby={`${id}-help`}
          onCheckedChange={(checked) => void toggleMagpie(checked)}
        />
      </div>
      {magpieMutation.isPending ? (
        <p className="settings-help" role="status">
          {t('settings.magpieSaving')}
        </p>
      ) : magpieMutation.error ? (
        <p className="settings-error" role="alert">
          {errorMessage(magpieMutation.error)}
        </p>
      ) : magpieUnavailable ? (
        <p className="settings-help" role="status">
          {t('settings.magpieUnavailable')}
        </p>
      ) : null}
    </fieldset>
  );
}
