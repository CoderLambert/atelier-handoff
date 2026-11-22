/**
 * @file 提供工作台的非模态锚点弹层。
 * @implementation 在 Portal 中使用 Radix 定位、关闭和焦点恢复，并统一可视区域边界。
 * @updated 2026-11-23T03:40:00+08:00
 */
import * as Primitive from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from './utils';

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;

export function PopoverContent({
  className,
  align = 'end',
  side = 'top',
  sideOffset = 8,
  collisionPadding = 12,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-50 max-h-(--radix-popover-content-available-height) overflow-auto overscroll-contain rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-(--ui-shadow-overlay) outline-none',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
