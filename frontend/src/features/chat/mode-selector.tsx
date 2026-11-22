/**
 * @file 提供会话运行模式选择和下次发送的搜索额度设置。
 * @implementation 组合模式选择与搜索额度设置，根据桌面本机能力和智能体约束显示可用选项。
 * @updated 2026-11-22T16:22:55+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useId } from 'react';
import { BookOpen, Globe, Monitor, Shield, Sparkles } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ComposerMode } from './run-mode';

const modes = {
  native: { labelKey: 'mode.native', descriptionKey: 'mode.nativeDescription', icon: Monitor },
  readonly: {
    labelKey: 'mode.readonly',
    descriptionKey: 'mode.readonlyDescription',
    icon: BookOpen,
  },
  edit: {
    labelKey: 'mode.controlled',
    descriptionKey: 'mode.controlledDescription',
    icon: Shield,
  },
  automatic: {
    labelKey: 'mode.automatic',
    descriptionKey: 'mode.automaticDescription',
    icon: Sparkles,
  },
} as const satisfies Record<
  ComposerMode,
  { labelKey: string; descriptionKey: string; icon: typeof BookOpen }
>;

export function ComposerModeSelector({
  mode,
  nativeExecution = false,
  readonlyProfile,
  disabled,
  searchChargeLimit,
  searchChargeError,
  onModeChange,
  onSearchChargeChange,
}: {
  mode: ComposerMode;
  nativeExecution?: boolean;
  readonlyProfile: boolean;
  disabled: boolean;
  searchChargeLimit: string;
  searchChargeError: string;
  onModeChange: (mode: ComposerMode) => void;
  onSearchChargeChange: (value: string) => void;
}) {
  const { t } = useUiTranslation('chat');
  const id = useId();
  const selected = modes[mode];
  const Icon = selected.icon;
  return (
    <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
      <Select
        value={mode}
        disabled={disabled}
        onValueChange={(value) => {
          if (
            value === 'readonly' ||
            value === 'edit' ||
            value === 'automatic' ||
            (value === 'native' && nativeExecution && !readonlyProfile)
          )
            onModeChange(value);
        }}
      >
        <SelectTrigger size="sm" aria-label={t('mode.label')} aria-describedby="composer-mode-help">
          <SelectValue>
            <Icon data-icon="inline-start" aria-hidden="true" />
            {t(selected.labelKey)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="end" sideOffset={4}>
          <SelectGroup>
            <SelectLabel>{t('mode.saved')}</SelectLabel>
            {(['native', 'readonly', 'edit', 'automatic'] as const)
              .filter((value) => value !== 'native' || (nativeExecution && !readonlyProfile))
              .map((value) => {
                const option = modes[value];
                const OptionIcon = option.icon;
                return (
                  <SelectItem
                    key={value}
                    value={value}
                    textValue={t(option.labelKey)}
                    disabled={readonlyProfile && value !== 'readonly'}
                  >
                    <OptionIcon data-icon="inline-start" aria-hidden="true" />
                    <span className="flex flex-col gap-0.5">
                      <span>{t(option.labelKey)}</span>
                      <span className="text-xs text-muted-foreground">
                        {readonlyProfile && value !== 'readonly'
                          ? t('mode.agentReadonly')
                          : t(option.descriptionKey)}
                      </span>
                    </span>
                  </SelectItem>
                );
              })}
          </SelectGroup>
        </SelectContent>
      </Select>
      {mode === 'automatic' ? (
        <Dialog>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              aria-label={t('mode.setSearchLimit')}
              aria-invalid={Boolean(searchChargeError)}
              aria-describedby={searchChargeError ? 'chat-composer-error' : undefined}
            >
              <Globe data-icon="inline-start" aria-hidden="true" />
              {t('mode.searchLimitSummary', {
                limit: searchChargeError
                  ? t('mode.checkLimit')
                  : t('mode.searchLimitFen', { amount: searchChargeLimit || '0' }),
              })}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('mode.searchSkill')}</DialogTitle>
              <DialogDescription>{t('mode.searchLimitDescription')}</DialogDescription>
            </DialogHeader>
            <label
              className="flex flex-col items-start gap-2"
              data-invalid={Boolean(searchChargeError)}
              data-disabled={disabled}
            >
              {t('mode.searchLimitLabel')}
              <input
                id={`${id}-limit`}
                type="number"
                min={0}
                max={100000}
                step={1}
                value={searchChargeLimit}
                disabled={disabled}
                aria-invalid={Boolean(searchChargeError)}
                aria-describedby={`${id}-help${searchChargeError ? ` ${id}-error` : ''}`}
                className="chat-field chat-search-limit"
                onChange={(event) => onSearchChargeChange(event.target.value)}
              />
            </label>
            <p id={`${id}-help`} className="mt-2 text-sm text-muted-foreground">
              {t('mode.searchLimitHelp')}
            </p>
            {searchChargeError ? (
              <p id={`${id}-error`} className="mt-2 text-sm text-destructive" role="alert">
                {searchChargeError}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button disabled={Boolean(searchChargeError)}>{t('mode.done')}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
