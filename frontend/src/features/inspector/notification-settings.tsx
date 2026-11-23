/**
 * @file 提供运行提示音与窗口焦点设置表单。
 * @implementation 呈现提示音开关、音量调节滑块、实时试听与自动聚焦窗口配置，变更即时持久化。
 * @updated 2026-11-23T15:35:00+08:00
 */
import { useId } from 'react';
import { Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useUiTranslation } from '@/i18n';
import { useUiNotifications } from '@/notifications';

export function NotificationSettings() {
  const { t } = useUiTranslation('inspector');
  const { notifications, updateNotifications, playTestSound } = useUiNotifications();

  const completionId = useId();
  const failureId = useId();
  const volumeId = useId();
  const focusId = useId();

  return (
    <div className="settings-form">
      <fieldset className="settings-form-section">
        <legend>{t('settings.notificationsSoundGroup')}</legend>
        <p className="settings-section-description">
          {t('settings.notificationsSoundGroupDescription')}
        </p>

        <div className="settings-field-row">
          <div className="settings-field-copy">
            <label htmlFor={completionId}>{t('settings.notificationsCompletionSound')}</label>
            <p>{t('settings.notificationsCompletionSoundDescription')}</p>
          </div>
          <div className="flex items-center justify-start pt-1">
            <Switch
              id={completionId}
              checked={notifications.completionSound}
              onCheckedChange={(checked) => updateNotifications({ completionSound: checked })}
            />
          </div>
        </div>

        <div className="settings-field-row">
          <div className="settings-field-copy">
            <label htmlFor={failureId}>{t('settings.notificationsFailureSound')}</label>
            <p>{t('settings.notificationsFailureSoundDescription')}</p>
          </div>
          <div className="flex items-center justify-start pt-1">
            <Switch
              id={failureId}
              checked={notifications.failureSound}
              onCheckedChange={(checked) => updateNotifications({ failureSound: checked })}
            />
          </div>
        </div>

        <div className="settings-field-row">
          <div className="settings-field-copy">
            <label htmlFor={volumeId}>{t('settings.notificationsVolume')}</label>
            <p>{t('settings.notificationsVolumeDescription')}</p>
          </div>
          <div className="flex flex-col gap-3 pt-1">
            <div className="flex items-center gap-3">
              <input
                id={volumeId}
                type="range"
                min="0"
                max="100"
                step="5"
                value={notifications.volume}
                onChange={(e) => updateNotifications({ volume: Number(e.target.value) })}
                className="w-48 accent-primary cursor-pointer"
                aria-label={t('settings.notificationsVolume')}
              />
              <span className="text-xs font-mono tabular-nums text-muted-foreground w-10">
                {notifications.volume}%
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={playTestSound}
                className="gap-1.5"
                aria-label={t('settings.notificationsTestSound')}
              >
                <Volume2 className="size-3.5" aria-hidden="true" />
                <span>{t('settings.notificationsTestSound')}</span>
              </Button>
            </div>
          </div>
        </div>
      </fieldset>

      <fieldset className="settings-form-section">
        <legend>{t('settings.notificationsWindowGroup')}</legend>
        <p className="settings-section-description">
          {t('settings.notificationsWindowGroupDescription')}
        </p>

        <div className="settings-field-row">
          <div className="settings-field-copy">
            <label htmlFor={focusId}>{t('settings.notificationsFocusOnCompletion')}</label>
            <p>{t('settings.notificationsFocusOnCompletionDescription')}</p>
          </div>
          <div className="flex items-center justify-start pt-1">
            <Switch
              id={focusId}
              checked={notifications.focusOnCompletion}
              onCheckedChange={(checked) => updateNotifications({ focusOnCompletion: checked })}
            />
          </div>
        </div>
      </fieldset>
    </div>
  );
}
