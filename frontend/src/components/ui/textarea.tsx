/**
 * @file 提供可复用的 shadcn 风格多行文本输入框组件。
 * @implementation 沿用 shadcn new-york v4 接口与 Atelier 语义主题 token，统一内边距、行高、柔和聚焦环与禁用态。
 * @updated 2026-11-28T00:10:00+08:00
 */
import * as React from 'react';
import { cn } from './utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-24 w-full min-w-0 rounded-md border border-border bg-card px-3 py-2 text-sm leading-relaxed text-foreground',
        'transition-[border-color,box-shadow,background-color] duration-(--motion-feedback) motion-reduce:transition-none',
        'hover:border-input placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground',
        'outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 resize-y',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
