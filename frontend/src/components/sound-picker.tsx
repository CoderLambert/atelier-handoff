/**
 * @file 提供提示音与音量的即时控制弹层。
 * @implementation 支持在侧边栏和设置快速调整提示音开关、音量滑块与实时试听，并提供完整设置入口。
 * @updated 2026-11-23T16:30:00+08:00
 */
import { ExternalLink, Volume2, VolumeX } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useUiTranslation } from '@/i18n';
import { useUiNotifications } from '@/notifications';

export function SoundPicker({
  align = 'end',
  side = 'bottom',
  onOpenSettings,
  collapsed,
  children,
}: {
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  onOpenSettings?: () => void;
  collapsed?: boolean;
  children?: ReactNode;
}) {
  const { t: tNav } = useUiTranslation('navigation');
  const { t: tInsp } = useUiTranslation('inspector');
  const { notifications, updateNotifications, playTestSound } = useUiNotifications();
  const [open, setOpen] = useState(false);

  const completionId = useId();
  const volumeId = useId();
  const focusId = useId();

  const isMuted = !notifications.completionSound || notifications.volume === 0;
  const label = isMuted
    ? tNav('sidebar.soundMuted')
    : tNav('sidebar.soundCurrent', { volume: notifications.volume });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {children ? (
          children
        ) : (
          <Button
            variant="ghost"
            size={collapsed ? 'icon-sm' : 'default'}
            aria-label={tNav('sidebar.soundToggle')}
            title={label}
          >
            {isMuted ? (
              <VolumeX data-icon="inline-start" aria-hidden="true" />
            ) : (
              <Volume2 data-icon="inline-start" aria-hidden="true" />
            )}
            {!collapsed ? label : null}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        sideOffset={8}
        className="w-72 p-4 text-xs space-y-3.5"
      >
        <div className="flex items-center justify-between border-b border-border-soft pb-2">
          <span className="font-semibold text-sm text-foreground">
            {tInsp('settings.notificationsSoundGroup')}
          </span>
          <span className="text-muted text-xs tabular-nums font-mono">
            {notifications.volume}%
          </span>
        </div>

        <div className="flex items-center justify-between gap-2">
          <label htmlFor={completionId} className="cursor-pointer text-foreground">
            {tInsp('settings.notificationsCompletionSound')}
          </label>
          <Switch
            id={completionId}
            checked={notifications.completionSound}
            onCheckedChange={(checked) => updateNotifications({ completionSound: checked })}
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-muted">
            <label htmlFor={volumeId}>{tInsp('settings.notificationsVolume')}</label>
          </div>
          <div className="flex items-center gap-2.5">
            <input
              id={volumeId}
              type="range"
              min="0"
              max="100"
              step="5"
              value={notifications.volume}
              onChange={(e) => updateNotifications({ volume: Number(e.target.value) })}
              className="flex-1 accent-primary cursor-pointer h-1.5"
              aria-label={tInsp('settings.notificationsVolume')}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={playTestSound}
              className="h-7 px-2 text-xs gap-1"
              title={tInsp('settings.notificationsTestSound')}
            >
              <Volume2 className="size-3" aria-hidden="true" />
              <span>{tInsp('settings.notificationsTestSound')}</span>
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1 border-t border-border-soft">
          <label htmlFor={focusId} className="cursor-pointer text-foreground">
            {tInsp('settings.notificationsFocusOnCompletion')}
          </label>
          <Switch
            id={focusId}
            checked={notifications.focusOnCompletion}
            onCheckedChange={(checked) => updateNotifications({ focusOnCompletion: checked })}
          />
        </div>

        {onOpenSettings ? (
          <div className="pt-2 border-t border-border-soft">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between h-7 text-xs text-muted hover:text-foreground"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              <span>{tInsp('settings.moreSettings')}</span>
              <ExternalLink className="size-3" aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
