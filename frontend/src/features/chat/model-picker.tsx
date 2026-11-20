/**
 * @file 为会话选择网关模型或跟随工作台默认值。
 * @implementation 在按需加载的 shadcn Select 中展示真实模型名称、ID 与路由信息，通过独立 Dialog 确认手动 ID。
 * @updated 2026-11-20T17:01:30+08:00
 */
import { useId, useRef, useState } from 'react';
import type { GatewayModelCatalog } from '@shared/types';
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

function routeDetails(model: GatewayModelCatalog['models'][number]) {
  return [
    model.provider ? `供应方：${model.provider}` : '',
    model.effort ? `推理深度 ${model.effort}` : '',
    model.serviceTier ? `服务档位 ${model.serviceTier}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function ModelPicker({
  model,
  defaultModel,
  disabled,
  onModelChange,
}: {
  model?: string;
  defaultModel: string;
  disabled: boolean;
  onModelChange: (model?: string) => void;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const catalog = useGatewayModels(open && !disabled);
  const workspaceDefault = catalog.data?.defaultModel ?? defaultModel;
  const models = catalog.data?.models ?? [];
  const currentModel = model ?? workspaceDefault;
  const currentRoute = models.find((entry) => entry.id === currentModel);
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
          className="max-w-64"
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
          className="w-96 max-w-[calc(100vw-32px)]"
          onCloseAutoFocus={(event) => {
            if (manualOpen) event.preventDefault();
          }}
        >
          <SelectGroup>
            <SelectLabel>模型 · 键入名称快速定位</SelectLabel>
            <SelectItem value={defaultValue} textValue={`跟随工作台默认 ${workspaceDefault}`}>
              <span className="flex min-w-0 flex-col gap-0.5 whitespace-normal wrap-anywhere">
                <span>跟随工作台默认</span>
                <span className="text-xs text-muted-foreground">{workspaceDefault}</span>
              </span>
            </SelectItem>
            {model !== undefined && !models.some((entry) => entry.id === model) ? (
              <SelectItem value={modelValue(model)} textValue={model}>
                <span className="flex min-w-0 flex-col gap-0.5 whitespace-normal wrap-anywhere">
                  <span>{model}</span>
                  <span className="text-xs text-muted-foreground">当前指定 · 未在列表中</span>
                </span>
              </SelectItem>
            ) : null}
            {models.map((entry) => (
              <SelectItem
                key={entry.id}
                value={modelValue(entry.id)}
                textValue={[entry.displayName, entry.id].filter(Boolean).join(' ')}
              >
                <span className="flex min-w-0 flex-col gap-0.5 whitespace-normal wrap-anywhere">
                  <span>
                    {entry.displayName || entry.id}
                    {entry.id === workspaceDefault ? ' · 工作台默认' : ''}
                  </span>
                  {entry.displayName && entry.displayName !== entry.id ? (
                    <span className="text-xs text-muted-foreground">{entry.id}</span>
                  ) : null}
                  {routeDetails(entry) ? (
                    <span className="text-xs text-muted-foreground">{routeDetails(entry)}</span>
                  ) : null}
                </span>
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
              手动输入模型 ID…
            </SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
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
