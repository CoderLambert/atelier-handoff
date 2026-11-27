/**
 * @file 提供 Skill 继承设置共用的展示和策略控件。
 * @implementation 展示来源、可用状态及原因，并提供策略选择、加载和错误反馈。
 * @updated 2026-11-26T00:06:59+08:00
 */
import { useUiTranslation } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { SkillInheritanceItem } from '@shared/skill-inheritance';

export const skillSources = {
  atelier: 'inheritance.sourceAtelier',
  workspace: 'inheritance.sourceWorkspace',
  host: 'inheritance.sourceHost',
} as const;

export const policies = {
  off: 'inheritance.policyOff',
  manual: 'inheritance.policyManual',
  auto: 'inheritance.policyAuto',
} as const;

const statusLabels = {
  off: 'inheritance.statusOff',
  manual: 'inheritance.statusManual',
  auto: 'inheritance.statusAuto',
} as const;

const reasonLabels = {
  'global-off': 'inheritance.reasonGlobalOff',
  'project-blocked': 'inheritance.reasonProjectBlocked',
  'not-native': 'inheritance.reasonNotNative',
  disabled: 'inheritance.reasonDisabled',
  'session-off': 'inheritance.reasonSessionOff',
} as const;

export function SkillIdentity({ item }: { item: SkillInheritanceItem }) {
  const { t } = useUiTranslation('extensions');
  return (
    <div className="skill-inheritance-identity">
      <strong>{item.name}</strong>
      {item.description ? (
        <p className="text-sm text-muted-foreground">{item.description}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{t(skillSources[item.source])}</span>
        {item.source === 'atelier' ? (
          <span>{t('inheritance.version', { version: item.version })}</span>
        ) : null}
      </div>
    </div>
  );
}

export function SkillAvailability({ item }: { item: SkillInheritanceItem }) {
  const { t } = useUiTranslation('extensions');
  const reason =
    item.reason === 'not-native' && item.source === 'workspace'
      ? 'inheritance.reasonWorkspaceMode'
      : item.reason && reasonLabels[item.reason];
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Badge
        variant={
          item.effective === 'off' ? 'secondary' : item.effective === 'auto' ? 'success' : 'outline'
        }
      >
        {t(statusLabels[item.effective])}
      </Badge>
      {reason ? <p className="text-xs text-muted-foreground">{t(reason)}</p> : null}
      {!item.manual && item.effective !== 'off' ? (
        <p className="text-xs text-muted-foreground">{t('extensions.manualUnsupported')}</p>
      ) : null}
    </div>
  );
}

export function SkillPolicySelect<Value extends string>({
  value,
  options,
  label,
  disabled,
  onChange,
}: {
  value: Value;
  options: readonly { value: Value; label: string; disabled?: boolean }[];
  label: string;
  disabled?: boolean;
  onChange: (value: Value) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((option) => option.value === next && !option.disabled);
        if (option && option.value !== value) onChange(option.value);
      }}
    >
      <SelectTrigger size="sm" className="justify-self-start" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function SkillAvailabilityFeedback({
  error,
  loading,
  fetching,
  reload,
  saveError,
  saving,
}: {
  error: boolean;
  loading: boolean;
  fetching: boolean;
  reload: () => void;
  saveError: unknown;
  saving: boolean;
}) {
  const { t } = useUiTranslation('extensions');
  return (
    <>
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive" role="alert">
            {t('inheritance.loadFailed')}
          </p>
          <Button type="button" variant="outline" size="sm" disabled={fetching} onClick={reload}>
            {t('common.reload')}
          </Button>
        </div>
      ) : null}
      {loading || saving ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t(saving ? 'common.saving' : 'inheritance.loading')}
        </p>
      ) : null}
      {saveError ? (
        <p className="text-sm text-destructive" role="alert">
          {t('inheritance.saveFailed')}
        </p>
      ) : null}
    </>
  );
}
