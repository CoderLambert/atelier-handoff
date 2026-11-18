import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './utils';

const buttonVariants = cva(
  'btn inline-flex min-w-0 items-center justify-center gap-2 focus-visible:outline focus-visible:outline-offset-2 disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'btn-primary',
        secondary: 'btn-secondary',
        outline: 'btn-secondary',
        ghost: 'btn-ghost',
        destructive: 'btn-danger',
        link: 'underline',
      },
      size: {
        default: '',
        sm: 'text-xs',
        lg: 'min-h-11',
        icon: 'size-9 p-0',
        'icon-sm': 'size-8 p-0',
        'icon-lg': 'size-11 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  asChild,
  className,
  size,
  variant,
  type,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Root = asChild ? Slot : 'button';
  return (
    <Root
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
