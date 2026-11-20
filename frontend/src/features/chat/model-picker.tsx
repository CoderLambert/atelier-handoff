/**
 * @file 为会话选择网关模型和推理深度。
 * @implementation 复用按需目录查询，在紧凑 Select 中展示模型名称与可选深度，锁定路由固定档位并通过 Dialog 确认手动 ID。
 * @updated 2026-11-20T17:14:57+08:00
 */
import { useId, useRef, useState } from 'react';
import { reasoningEfforts, type ReasoningEffort } from '@shared/types';
import { Button } from '@/components/ui/button';
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

const effortLabels: Record<ReasoningEffort, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};

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
    ? effortLabels[selectedEffort]
    : fixedEffort !== undefined
      ? '固定'
      : '默认';
  const effortTitle =
    fixedEffort !== undefined
      ? `网关路由已固定推理深度为 ${fixedEffort}，无法在会话中更改。`
      : unsupportedEffort
        ? '当前模型不支持已保存的推理深度，请选择默认或可用档位。'
        : !supportedEfforts.length
          ? '此模型不支持调整推理深度，使用默认设置。'
          : '推理深度随当前会话保存；默认由模型或网关决定。';
  const manualId = manualInput.trim();
  const manualValid = manualId.length <= 200 && /^\S+$/u.test(manualId);
  const manualError = manualId && !manualValid ? '模型 ID 最多 200 个字符，不能包含空白。' : '';

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
            void catalog.refetch();
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
          className="min-w-0 max-w-48 [&_[data-slot=select-value]]:min-w-0"
          aria-label="选择模型"
          title={`模型 · ${currentModel}${model === undefined ? ' · 跟随工作台默认' : ''}`}
        >
          <SelectValue>
            <span className="truncate">模型 · {currentRoute?.displayName || currentModel}</span>
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
            <SelectLabel>模型</SelectLabel>
            <SelectItem
              value={defaultValue}
              textValue={`跟随默认 ${workspaceDefault}`}
              title={`跟随工作台默认 · ${workspaceDefault}`}
            >
              跟随默认
            </SelectItem>
            {model !== undefined && !models.some((entry) => entry.id === model) ? (
              <SelectItem
                value={modelValue(model)}
                textValue={model}
                title={model}
                className="[&>span:last-child]:min-w-0"
              >
                <span className="truncate">{model}</span>
              </SelectItem>
            ) : null}
            {models.map((entry) => (
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
          {catalog.isFetching ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground" role="status">
              {catalog.data ? '正在刷新模型列表…' : '正在加载模型列表…'}
            </p>
          ) : null}
          {catalog.isError ? (
            <p className="px-2 py-1.5 text-xs text-destructive wrap-anywhere" role="alert">
              模型列表加载失败：
              {catalog.error instanceof Error ? catalog.error.message : '请重试。'}
            </p>
          ) : catalog.data && !catalog.data.routesAvailable ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground" role="status">
              网关路由列表暂不可用，仍可跟随默认或手动输入 ID。
            </p>
          ) : catalog.data && !models.length ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground" role="status">
              模型列表为空，仍可跟随默认或手动输入 ID。
            </p>
          ) : null}
          <SelectSeparator />
          <SelectGroup>
            {catalog.isError ? (
              <SelectItem value={retryValue} disabled={catalog.isFetching} textValue="重新加载模型">
                重新加载模型
              </SelectItem>
            ) : null}
            <SelectItem value={manualValue} textValue="手动输入模型 ID">
              手动输入 ID…
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
          className="shrink-0"
          aria-label="选择推理深度"
          aria-describedby={`${id}-effort-help`}
          aria-invalid={fixedEffort === undefined && unsupportedEffort}
          title={effortTitle}
        >
          <SelectValue>深度 · {effortLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" side="top" align="end" sideOffset={4}>
          <SelectGroup>
            <SelectLabel>推理深度</SelectLabel>
            <SelectItem value={defaultValue}>默认</SelectItem>
            {supportedEfforts.map((level) => (
              <SelectItem key={level} value={level}>
                {effortLabels[level]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
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
            <DialogTitle>手动输入模型 ID</DialogTitle>
            <DialogDescription>输入完整模型 ID，发送时由网关确认是否可用。</DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1" data-invalid={Boolean(manualError)}>
            <span className="text-sm">模型 ID</span>
            <input
              id={`${id}-manual`}
              value={manualInput}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              className="field m-0!"
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
            className="mt-2 text-sm text-muted-foreground"
            role={manualError ? 'alert' : undefined}
          >
            {manualError || '最多 200 个字符，不包含空白。'}
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <Button disabled={disabled || !manualValid} onClick={() => select(manualId)}>
              使用此模型
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
