/**
 * @file 提供统一的表单字段容器、标签、说明文案与错误回显原语。
 * @implementation 基于 Atelier 语义令牌统一表单标签字重、间距与破坏性错误提示，配合 Input/Textarea/Select 使用。
 * @updated 2026-11-28T00:08:00+08:00
 */
import * as React from 'react';
import { cn } from './utils';

function Field({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="field" className={cn('flex flex-col gap-1.5', className)} {...props} />;
}

function FieldLabel({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="field-label"
      className={cn(
        'inline-flex items-center gap-1.5 text-[13px] font-medium leading-snug text-foreground',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn('text-xs leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}

function FieldError({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      role="alert"
      data-slot="field-error"
      className={cn('text-xs font-medium leading-snug text-destructive', className)}
      {...props}
    />
  );
}

export { Field, FieldLabel, FieldDescription, FieldError };
