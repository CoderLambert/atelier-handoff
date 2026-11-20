/**
 * @file 提供会话运行模式选择和下次发送的搜索额度设置。
 * @implementation 组合 Radix Select 与按需 Dialog，通过受控属性保留会话模式和临时搜索上限。
 * @updated 2026-11-20T15:49:33+08:00
 */
import { useId } from 'react';
import { BookOpen, Globe, ShieldCheck, Sparkles } from 'lucide-react';
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
  readonly: { label: '只读', description: '先讨论，不修改文件', icon: BookOpen },
  edit: { label: '受控修改', description: '需要审批的操作逐次确认', icon: ShieldCheck },
  automatic: { label: '全工具自动化', description: '自动批准可用工具操作', icon: Sparkles },
} satisfies Record<ComposerMode, { label: string; description: string; icon: typeof BookOpen }>;

export function ComposerModeSelector({
  mode,
  readonlyProfile,
  disabled,
  searchChargeLimit,
  searchChargeError,
  onModeChange,
  onSearchChargeChange,
}: {
  mode: ComposerMode;
  readonlyProfile: boolean;
  disabled: boolean;
  searchChargeLimit: string;
  searchChargeError: string;
  onModeChange: (mode: ComposerMode) => void;
  onSearchChargeChange: (value: string) => void;
}) {
  const id = useId();
  const selected = modes[mode];
  const Icon = selected.icon;
  return (
    <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
      <Select
        value={mode}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === 'readonly' || value === 'edit' || value === 'automatic')
            onModeChange(value);
        }}
      >
        <SelectTrigger size="sm" aria-label="运行模式" aria-describedby="composer-mode-help">
          <SelectValue>
            <Icon aria-hidden="true" />
            {selected.label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="end" sideOffset={4}>
          <SelectGroup>
            <SelectLabel>运行模式 · 随会话保存</SelectLabel>
            {(['readonly', 'edit', 'automatic'] as const).map((value) => {
              const option = modes[value];
              const OptionIcon = option.icon;
              return (
                <SelectItem
                  key={value}
                  value={value}
                  textValue={option.label}
                  disabled={readonlyProfile && value !== 'readonly'}
                >
                  <OptionIcon aria-hidden="true" />
                  <span className="flex flex-col gap-0.5">
                    <span>{option.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {readonlyProfile && value !== 'readonly'
                        ? '当前智能体仅支持只读'
                        : option.description}
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
              className="min-h-8! px-2! py-1! [&_svg]:size-3.5"
              disabled={disabled}
              aria-label="设置全网搜索 Skill 单次上限"
              aria-invalid={Boolean(searchChargeError)}
              aria-describedby={searchChargeError ? 'chat-composer-error' : undefined}
            >
              <Globe data-icon="inline-start" aria-hidden="true" />
              全网搜索 Skill · {searchChargeError ? '检查上限' : `${searchChargeLimit || '0'} 分`}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>全网搜索 Skill</DialogTitle>
              <DialogDescription>此上限仅用于下次发送，发送后恢复为 0 分。</DialogDescription>
            </DialogHeader>
            <label
              className="flex flex-col items-start gap-2"
              data-invalid={Boolean(searchChargeError)}
              data-disabled={disabled}
            >
              全网搜索 Skill 单次上限（分）
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
                className="h-9 w-32 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                onChange={(event) => onSearchChargeChange(event.target.value)}
              />
            </label>
            <p id={`${id}-help`} className="mt-2 text-sm text-muted-foreground">
              仅限制该 Skill 的单次请求费用，不是任务总费用上限。留空按 0 分处理。
            </p>
            {searchChargeError ? (
              <p id={`${id}-error`} className="mt-2 text-sm text-destructive" role="alert">
                {searchChargeError}
              </p>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button disabled={Boolean(searchChargeError)}>完成</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
