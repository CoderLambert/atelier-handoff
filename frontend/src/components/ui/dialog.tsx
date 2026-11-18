import * as Primitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from './utils';

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
export const DialogPortal = Primitive.Portal;

export function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: ComponentProps<typeof Primitive.Content> & { showCloseButton?: boolean }) {
  return (
    <DialogPortal>
      <Primitive.Overlay className="react-dialog-overlay fixed inset-0 z-50" />
      <Primitive.Content className={cn('react-dialog fixed z-50', className)} {...props}>
        {children}
        {showCloseButton ? (
          <DialogClose className="react-dialog-dismiss icon-button" aria-label="关闭详情">
            <X size={17} />
          </DialogClose>
        ) : null}
      </Primitive.Content>
    </DialogPortal>
  );
}
export function DialogHeader({ className, ...props }: ComponentProps<'header'>) {
  return <header className={cn('react-dialog-header', className)} {...props} />;
}
export function DialogFooter({ className, ...props }: ComponentProps<'footer'>) {
  return <footer className={cn('dialog-actions', className)} {...props} />;
}
export function DialogTitle({ className, ...props }: ComponentProps<typeof Primitive.Title>) {
  return <Primitive.Title className={cn('text-lg font-semibold', className)} {...props} />;
}
export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof Primitive.Description>) {
  return (
    <Primitive.Description className={cn('text-sm text-[var(--muted)]', className)} {...props} />
  );
}
