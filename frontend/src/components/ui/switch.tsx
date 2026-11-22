/**
 * @file 提供使用原生表单语义的受控开关。
 * @implementation 由 checked 与 onCheckedChange 传递唯一状态，复用 checkbox 的标签、键盘、表单和 fieldset 禁用语义，以主题轨道和滑块呈现开关。
 * @updated 2026-11-23T04:58:09+08:00
 */
import type { ComponentProps } from 'react';
import { cn } from './utils';

type SwitchProps = Omit<
  ComponentProps<'input'>,
  'type' | 'role' | 'checked' | 'defaultChecked' | 'onChange'
> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

export function Switch({ className, checked, onCheckedChange, disabled, ...props }: SwitchProps) {
  return (
    <span
      data-slot="switch-root"
      className={cn('relative inline-flex h-6 w-10 shrink-0 align-middle', className)}
    >
      <input
        {...props}
        data-slot="switch"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
        className="peer absolute inset-0 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden="true"
        data-slot="switch-track"
        className="pointer-events-none inline-flex size-full items-center rounded-full border border-input bg-muted p-[3px] peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:opacity-50 peer-checked:[&>span]:translate-x-4 peer-checked:[&>span]:bg-primary-foreground"
      >
        <span
          data-slot="switch-thumb"
          className="size-4 rounded-full bg-muted-foreground transition-transform duration-(--motion-fast) ease-(--ease-standard) motion-reduce:transition-none"
        />
      </span>
    </span>
  );
}
