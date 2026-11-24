/**
 * @file 为会话选择网关模型和推理深度。
 * @implementation 按来源分组展示模型目录和可选深度，保留路由固定档位。Magpie 关闭时提示既有选择不可用，并在手动输入时校验。
 * @updated 2026-11-24T01:00:00+08:00
 */
import { useUiTranslation, translateError } from '@/i18n';
import { useId, useRef, useState } from 'react';
import { magpieModelPrefix, reasoningEfforts, type ReasoningEffort } from '@shared/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useGatewayModels } from '@/use-query/settings/use-gateway-models';

const defaultValue = 'workspace-default';
const manualValue = 'manual-entry';
const retryValue = 'retry-catalog';
const modelValue = (id: string) => `model:${id}`;

const effortLabels = {
  low: 'model.effortLow',
  medium: 'model.effortMedium',
  high: 'model.effortHigh',
  xhigh: 'model.effortVeryHigh',
  max: 'model.effortMax',
} as const satisfies Record<ReasoningEffort, string>;

export function ModelPicker({
  model,
  effort,
  defaultModel,
  disabled,
  onModelChange,
  onEffortChange,
}: {
  model?: string;
  effort?: ReasoningEffort;
  defaultModel: string;
  disabled: boolean;
  onModelChange: (model?: string) => void;
  onEffortChange: (effort?: ReasoningEffort) => void;
}) {
  const { t } = useUiTranslation('chat');
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const catalog = useGatewayModels((open || effortOpen) && !disabled);
  const workspaceDefault = catalog.data?.defaultModel ?? defaultModel;
  const models = catalog.data?.models ?? [];
  const currentModel = model ?? workspaceDefault;
  const magpieDisabled = (id: string) => !catalog.magpieEnabled && id.startsWith(magpieModelPrefix);
  const modelUnavailable = magpieDisabled(currentModel);
  const currentRoute = models.find((entry) => entry.id === currentModel);
  const fixedEffort = currentRoute?.effort;
  const selectedEffort =
    fixedEffort === undefined ? effort : reasoningEfforts.find((level) => level === fixedEffort);
  const supportedEfforts = reasoningEfforts.filter(
    (level) => !currentRoute?.supportedEfforts || currentRoute.supportedEfforts.includes(level),
  );
  const effortDisabled = disabled || fixedEffort !== undefined;
  const unsupportedEffort = effort !== undefined && !supportedEfforts.includes(effort);
  const effortLabel = selectedEffort
    ? t(effortLabels[selectedEffort])
    : fixedEffort !== undefined
      ? t('model.fixed')
      : t('model.default');
  const effortTitle =
    fixedEffort !== undefined
      ? t('model.fixedEffortHelp', {
          effort: selectedEffort ? t(effortLabels[selectedEffort]) : fixedEffort,
        })
      : unsupportedEffort
        ? t('model.unsupportedEffort')
        : !supportedEfforts.length
          ? t('model.noEffort')
          : t('model.effortHelp');
  const discovery = catalog.data?.discovery;
  const discoveryMessages = [
    discovery?.routes.status === 'partial'
      ? t('model.routesPartial')
      : discovery?.routes.status === 'unavailable'
        ? t('model.routesUnavailable')
        : undefined,
    discovery?.codex.status === 'stale'
      ? t('model.supplementStale')
      : discovery?.codex.status === 'partial'
        ? t('model.supplementPartial')
        : discovery?.codex.status === 'unavailable'
          ? t('model.supplementUnavailable')
          : undefined,
    discovery?.magpie?.status === 'partial' ? t('model.magpiePartial') : undefined,
  ].filter(Boolean);
  const manualId = manualInput.trim();
  const magpieNotice = t('model.magpieDisabledHelp');
  const manualError = magpieDisabled(manualId)
    ? magpieNotice
    : manualId && (manualId.length > 200 || !/^\S+$/u.test(manualId))
      ? t('model.invalidId')
      : '';
  const manualValid = Boolean(manualId && !manualError);

  function select(value?: string) {
    if (disabled) return;
    onModelChange(value);
    setManualOpen(false);
    setOpen(false);
  }

  return (
    <>
      <Select
        value={model === undefined ? defaultValue : modelValue(model)}
        open={open && !disabled}
        onOpenChange={setOpen}
        disabled={disabled}
        onValueChange={(value) => {
          if (disabled) return;
          if (value === manualValue) {
            setManualInput(model ?? '');
            setManualOpen(true);
            setOpen(false);
          } else if (value === retryValue) {
            void catalog.refresh();
          } else if (value === defaultValue) {
            select();
          } else {
            const entry = models.find((item) => modelValue(item.id) === value);
            if (entry) select(entry.id);
          }
        }}
      >
        <SelectTrigger
          ref={triggerRef}
          size="sm"
          className="composer-ghost-select min-w-0 max-w-48 [&_[data-slot=select-value]]:min-w-0"
          aria-label={t('model.choose')}
          aria-describedby={modelUnavailable ? `${id}-model-help` : undefined}
          title={
            modelUnavailable
              ? magpieNotice
              : t('model.triggerTitle', {
                  model: currentModel,
                  defaultNote: model === undefined ? t('model.defaultNote') : '',
                })
          }
        >
          <SelectValue>
            <span className="truncate">
              {modelUnavailable
                ? t('model.magpieDisabled')
                : t('model.current', { model: currentRoute?.displayName || currentModel })}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent
          position="popper"
          side="top"
          align="end"
          sideOffset={4}
          className="max-h-[min(20rem,var(--radix-select-content-available-height))] w-72 max-w-[calc(100vw-32px)]"
          onCloseAutoFocus={(event) => {
            if (manualOpen) event.preventDefault();
          }}
        >
          <SelectGroup>
            <SelectLabel>{t('model.label')}</SelectLabel>
            <SelectItem
              value={defaultValue}
              textValue={t('model.defaultText', { model: workspaceDefault })}
              title={t('model.defaultTitle', { model: workspaceDefault })}
              disabled={magpieDisabled(workspaceDefault)}
            >
              {magpieDisabled(workspaceDefault)
                ? t('model.defaultDisabled')
                : t('model.useDefault')}
            </SelectItem>
            {model !== undefined && !models.some((entry) => entry.id === model) ? (
              <SelectItem
                value={modelValue(model)}
                textValue={model}
                title={model}
                className="[&>span:last-child]:min-w-0"
                disabled={modelUnavailable}
              >
                <span className="truncate">
                  {modelUnavailable ? t('model.disabledEntry', { model }) : model}
                </span>
              </SelectItem>
            ) : null}
          </SelectGroup>
          {(['Shunt', 'Magpie'] as const).map((gateway) => {
            const entries = models.filter(
              (entry) => (entry.source === 'magpie' ? 'Magpie' : 'Shunt') === gateway,
            );
            if (!entries.length) return null;
            return (
              <SelectGroup key={gateway}>
                <SelectLabel>{gateway}</SelectLabel>
                {entries.map((entry) => (
                  <SelectItem
                    key={entry.id}
                    value={modelValue(entry.id)}
                    textValue={[entry.displayName, entry.id].filter(Boolean).join(' ')}
                    title={entry.id}
                    className="[&>span:last-child]:min-w-0"
                  >
                    <span className="truncate">{entry.displayName || entry.id}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            );
          })}
          {catalog.isFetching ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground" role="status">
              {catalog.data ? t('model.refreshing') : t('model.loading')}
            </p>
          ) : null}
          {catalog.isError ? (
            <p className="px-2 py-1.5 text-xs text-destructive wrap-anywhere" role="alert">
              {t('model.loadFailed', { message: translateError(catalog.error, t('model.retry')) })}
            </p>
          ) : catalog.data && !models.length ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground" role="status">
              {t('model.empty')}
            </p>
          ) : null}
          {discoveryMessages.map((message) => (
            <p key={message} className="px-2 py-1.5 text-xs text-warning" role="status">
              {message}
            </p>
          ))}
          <SelectSeparator />
          <SelectGroup>
            <SelectItem
              value={retryValue}
              disabled={catalog.isFetching}
              textValue={t('model.refresh')}
            >
              {catalog.isError ? t('model.reload') : t('model.refresh')}
            </SelectItem>
            <SelectItem value={manualValue} textValue={t('model.manualTitle')}>
              {t('model.manual')}
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <Select
        value={fixedEffort ?? effort ?? defaultValue}
        open={effortOpen && !effortDisabled}
        onOpenChange={setEffortOpen}
        disabled={effortDisabled}
        onValueChange={(value) => {
          if (effortDisabled) return;
          if (value === defaultValue) onEffortChange();
          else {
            const level = supportedEfforts.find((entry) => entry === value);
            if (level) onEffortChange(level);
          }
        }}
      >
        <SelectTrigger
          size="sm"
          className="composer-ghost-select shrink-0"
          aria-label={t('model.chooseEffort')}
          aria-describedby={`${id}-effort-help`}
          aria-invalid={fixedEffort === undefined && unsupportedEffort}
          title={effortTitle}
        >
          <SelectValue>{t('model.effortSummary', { effort: effortLabel })}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" side="top" align="end" sideOffset={4}>
          <SelectGroup>
            <SelectLabel>{t('model.effort')}</SelectLabel>
            <SelectItem value={defaultValue}>{t('model.default')}</SelectItem>
            {supportedEfforts.map((level) => (
              <SelectItem key={level} value={level}>
                {t(effortLabels[level])}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {modelUnavailable ? (
        <span id={`${id}-model-help`} className="sr-only">
          {magpieNotice}
        </span>
      ) : null}
      <span id={`${id}-effort-help`} className="sr-only">
        {effortTitle}
      </span>
      <Dialog open={manualOpen && !disabled} onOpenChange={setManualOpen}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('model.manualTitle')}</DialogTitle>
            <DialogDescription>{t('model.manualDescription')}</DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1" data-invalid={Boolean(manualError)}>
            <span className="text-sm">{t('model.id')}</span>
            <input
              id={`${id}-manual`}
              value={manualInput}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              className="chat-field"
              aria-invalid={Boolean(manualError)}
              aria-describedby={`${id}-manual-help`}
              onChange={(event) => setManualInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                event.stopPropagation();
                if (manualValid) select(manualId);
              }}
            />
          </label>
          <p
            id={`${id}-manual-help`}
            className={cn('text-sm', manualError ? 'text-destructive' : 'text-muted-foreground')}
            role={manualError ? 'alert' : undefined}
          >
            {manualError || t('model.idHelp')}
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t('model.cancel')}</Button>
            </DialogClose>
            <Button disabled={disabled || !manualValid} onClick={() => select(manualId)}>
              {t('model.use')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
