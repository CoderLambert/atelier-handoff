/**
 * @file 提供共享语义徽章组件。
 * @implementation 使用 CVA 定义主题变体，并支持通过 Slot 将样式应用于子元素。
 * @updated 2026-11-23T04:48:08+08:00
 */
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './utils';

const badgeVariants = cva(
  'inline-flex max-w-full min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium leading-none [overflow-wrap:anywhere] transition-colors [&>[data-icon]]:size-3 [&>[data-icon]]:shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive-soft text-destructive',
        outline: 'border-border text-foreground',
        ghost: 'border-transparent text-foreground',
        link: 'border-transparent text-primary underline-offset-4',
        info: 'border-transparent bg-info-soft text-info',
        success: 'border-transparent bg-success-soft text-success',
        warning: 'border-transparent bg-warning-soft text-warning',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export type BadgeProps = ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean };

export function Badge({ asChild, className, variant, ...props }: BadgeProps) {
  const Root = asChild ? Slot : 'span';
  return (
    <Root
      data-slot="badge"
      data-variant={variant ?? 'default'}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { badgeVariants };
