/**
 * @file 提供运行提示音与窗口焦点设置表单。
 * @implementation 呈现提示音风格切换、开关、音量调节滑块、实时试听、自动聚焦与桌面托盘常驻配置，变更即时持久化。
 * @updated 2026-11-27T23:50:00+08:00
 */
import { useId } from 'react';
import { Volume2 } from 'lucide-react';
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
import { useUiTranslation } from '@/i18n';
import { useUiNotifications } from '@/notifications';
import { type SoundTheme } from '@shared/desktop-ui-notifications';

export function NotificationSettings() {
  const { t } = useUiTranslation('inspector');
  const { notifications, updateNotifications, playTestSound } = useUiNotifications();
  const isDesktop = typeof window !== 'undefined' && Boolean(window.atelierUiNotifications);

  const completionId = useId();
  const themeId = useId();
  const failureId = useId();
  const volumeId = useId();
  const focusId = useId();
  const trayId = useId();

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
            <label htmlFor={themeId}>{t('settings.notificationsSoundTheme')}</label>
            <p>{t('settings.notificationsSoundThemeDescription')}</p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Select
              value={notifications.soundTheme}
              onValueChange={(value) => {
                const nextTheme = value as SoundTheme;
                updateNotifications({ soundTheme: nextTheme });
                playTestSound(nextTheme);
              }}
            >
              <SelectTrigger id={themeId} className="w-64 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectGroup>
                  <SelectItem value="codex">
                    {t('settings.notificationsSoundThemeCodex')}
                  </SelectItem>
                  <SelectItem value="chime">
                    {t('settings.notificationsSoundThemeChime')}
                  </SelectItem>
                  <SelectItem value="marimba">
                    {t('settings.notificationsSoundThemeMarimba')}
                  </SelectItem>
                  <SelectItem value="bubble">
                    {t('settings.notificationsSoundThemeBubble')}
                  </SelectItem>
                  <SelectItem value="ping">{t('settings.notificationsSoundThemePing')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
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
                onClick={() => playTestSound(notifications.soundTheme)}
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

        {isDesktop && (
          <div className="settings-field-row">
            <div className="settings-field-copy">
              <label htmlFor={trayId}>{t('settings.notificationsMinimizeToTray')}</label>
              <p>{t('settings.notificationsMinimizeToTrayDescription')}</p>
            </div>
            <div className="flex items-center justify-start pt-1">
              <Switch
                id={trayId}
                checked={notifications.minimizeToTrayOnClose}
                onCheckedChange={(checked) =>
                  updateNotifications({ minimizeToTrayOnClose: checked })
                }
              />
            </div>
          </div>
        )}
      </fieldset>
    </div>
  );
}
