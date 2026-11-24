/**
 * @file 选择本次 AI 多提交规划使用的模型。
 * @implementation 组合现有目录查询状态与 Select，提供默认、目录和手动 ID；只通知弹窗局部选择，不写聊天或配置。
 * @updated 2026-11-24T18:00:00+08:00
 */
import { useId, useState } from 'react';
import { gatewayModelSchema, magpieModelPrefix } from '@shared/types';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUiTranslation } from '@/i18n';
import type { useGatewayModels } from '@/use-query/settings/use-gateway-models';
import './git-multi-commit-model-picker.css';

const defaultValue = 'default';
const manualValue = 'manual';
const modelValue = (model: string) => `model:${model}`;

export function GitMultiCommitModelPicker({
  model,
  defaultModel,
  catalog,
  disabled,
  onModelChange,
}: {
  model?: string;
  defaultModel?: string;
  catalog: ReturnType<typeof useGatewayModels>;
  disabled: boolean;
  onModelChange: (model?: string) => void;
}) {
  const { t } = useUiTranslation('git');
  const id = useId();
  const [manual, setManual] = useState(false);
  const models = catalog.data?.models ?? [];
  const current = model ?? defaultModel;
  const magpieDisabled = (value?: string) =>
    !catalog.magpieEnabled && value?.trim().startsWith(magpieModelPrefix) === true;
  const error = magpieDisabled(current)
    ? t('multi.model.magpieDisabled')
    : model !== undefined && !gatewayModelSchema.shape.id.safeParse(model).success
      ? t('multi.model.invalid')
      : undefined;
  const selected = models.find((entry) => entry.id === model);
  const label =
    model === undefined
      ? defaultModel
        ? t('multi.model.defaultNamed', { model: defaultModel })
        : t('multi.model.default')
      : selected?.displayName || model || t('multi.model.manual');

  return (
    <div className="git-multi-commit-model-picker">
      <label htmlFor={id}>{t('multi.model.label')}</label>
      <div className="git-multi-commit-model-controls">
        <Select
          value={manual ? manualValue : model === undefined ? defaultValue : modelValue(model)}
          disabled={disabled}
          onValueChange={(value) => {
            if (disabled) return;
            if (value === manualValue) {
              setManual(true);
              onModelChange(model ?? '');
            } else {
              setManual(false);
              onModelChange(value === defaultValue ? undefined : value.slice('model:'.length));
            }
          }}
        >
          <SelectTrigger
            id={id}
            aria-describedby={`${id}-help`}
            aria-invalid={Boolean(error)}
            title={label}
          >
            <SelectValue>{label}</SelectValue>
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectGroup>
              <SelectItem value={defaultValue} disabled={magpieDisabled(defaultModel)}>
                {defaultModel
                  ? t('multi.model.defaultNamed', { model: defaultModel })
                  : t('multi.model.default')}
              </SelectItem>
              {model && !models.some((entry) => entry.id === model) ? (
                <SelectItem value={modelValue(model)} disabled={magpieDisabled(model)}>
                  {model}
                </SelectItem>
              ) : null}
              <SelectItem value={manualValue}>{t('multi.model.manual')}</SelectItem>
            </SelectGroup>
            {(['Shunt', 'Magpie'] as const).map((source) => {
              const entries = models.filter(
                (entry) => (entry.source === 'magpie' ? 'Magpie' : 'Shunt') === source,
              );
              return entries.length ? (
                <SelectGroup key={source}>
                  <SelectLabel>{source}</SelectLabel>
                  {entries.map((entry) => (
                    <SelectItem
                      key={entry.id}
                      value={modelValue(entry.id)}
                      disabled={magpieDisabled(entry.id)}
                      title={entry.id}
                    >
                      {entry.displayName || entry.id}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null;
            })}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || catalog.isFetching}
          onClick={() => void catalog.refresh()}
        >
          {t('multi.model.refresh')}
        </Button>
      </div>
      {manual ? (
        <label className="git-multi-commit-field" data-invalid={Boolean(error)}>
          <span>{t('multi.model.id')}</span>
          <input
            value={model ?? ''}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-help`}
            onChange={(event) => onModelChange(event.target.value)}
          />
        </label>
      ) : null}
      <p id={`${id}-help`} role={error ? 'alert' : undefined}>
        {error || t('multi.model.localOnly')}
      </p>
      {catalog.isFetching ? <p role="status">{t('multi.model.loading')}</p> : null}
      {!catalog.isFetching && catalog.isError ? (
        <p role="status">{t('multi.model.failed')}</p>
      ) : null}
      {!catalog.isFetching && catalog.data && !models.length ? (
        <p role="status">{t('multi.model.empty')}</p>
      ) : null}
      {!catalog.isFetching &&
      catalog.data &&
      Object.values(catalog.data.discovery).some(
        (source) => source && ['partial', 'unavailable', 'stale'].includes(source.status),
      ) ? (
        <p role="status">{t('multi.model.partial')}</p>
      ) : null}
    </div>
  );
}
