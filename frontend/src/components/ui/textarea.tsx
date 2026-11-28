/**
 * @file 提供可复用的 shadcn 风格多行文本输入框组件。
 * @implementation 沿用 shadcn new-york v4 接口与 Atelier 语义主题 token，统一内边距、行高、聚焦环与禁用态。
 * @updated 2026-11-27T23:45:00+08:00
 */
import * as React from 'react';
import { cn } from './utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-24 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-sm leading-relaxed text-foreground',
        'transition-colors duration-(--motion-feedback) motion-reduce:transition-none',
        'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive resize-y',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
