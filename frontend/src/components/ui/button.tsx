/**
 * @file 提供工作台按钮与按钮外观的链接。
 * @implementation 通过 CVA 统一操作级别、控件尺寸、图标、柔和焦点环和反馈，保留原生按钮或 Slot 子节点语义。
 * @updated 2026-11-28T00:10:00+08:00
 */
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './utils';

const buttonVariants = cva(
  [
    'inline-flex min-w-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-sm font-medium leading-tight',
    'transition-[background-color,color,border-color,box-shadow,transform] duration-(--motion-feedback) ease-(--ease-standard) motion-reduce:transition-none active:scale-[0.98]',
    'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-50',
    '[&>svg]:pointer-events-none [&>svg]:size-(--ui-icon-size) [&>svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent active:bg-selected',
        outline:
          'border-border bg-card text-card-foreground hover:bg-accent active:bg-selected focus-visible:border-ring',
        ghost:
          'text-secondary-foreground hover:bg-accent hover:text-accent-foreground active:bg-selected',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/85',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        xs: 'min-h-(--ui-size-xs) gap-1 px-2 text-xs',
        sm: 'min-h-(--ui-size-sm) gap-1.5 px-2.5',
        default: 'min-h-(--ui-size-md) px-3',
        lg: 'min-h-(--ui-size-lg) px-4 text-base',
        'icon-xs': 'size-(--ui-size-xs) shrink-0',
        'icon-sm': 'size-(--ui-size-sm) shrink-0',
        icon: 'size-(--ui-size-md) shrink-0',
        'icon-lg': 'size-(--ui-size-lg) shrink-0 [&>svg]:size-(--ui-icon-size-emphasis)',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  asChild,
  className,
  size = 'default',
  variant = 'default',
  type,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Root = asChild ? Slot : 'button';
  return (
    <Root
      type={asChild ? undefined : (type ?? 'button')}
      data-slot="button"
      data-size={size}
      data-variant={variant}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
