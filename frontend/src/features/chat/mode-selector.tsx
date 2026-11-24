/**
 * @file 提供会话运行模式选择。
 * @implementation 根据桌面本机能力和智能体约束显示可用选项。
 * @updated 2026-11-24T01:00:00+08:00
 */
import { useUiTranslation } from '@/i18n';
import { BookOpen, Monitor, Shield, Sparkles } from 'lucide-react';
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
  onModeChange,
}: {
  mode: ComposerMode;
  nativeExecution?: boolean;
  readonlyProfile: boolean;
  disabled: boolean;
  onModeChange: (mode: ComposerMode) => void;
}) {
  const { t } = useUiTranslation('chat');
  const selected = modes[mode];
  const Icon = selected.icon;
  return (
    <div className="flex max-w-full flex-wrap items-center gap-2">
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
        <SelectTrigger
          size="sm"
          className="composer-mode-trigger"
          data-mode={mode}
          aria-label={t('mode.label')}
          aria-describedby="composer-mode-help"
        >
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
    </div>
  );
}
