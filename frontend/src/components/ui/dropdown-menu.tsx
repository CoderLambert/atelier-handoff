/**
 * @file 提供工作台的下拉菜单控件。
 * @implementation 封装 Radix UI DropdownMenu，使用统一主题变量、圆角与覆盖层阴影。
 * @updated 2026-11-25T03:30:00+08:00
 */
import * as Primitive from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from './utils';

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;

export function DropdownMenuContent({
  className,
  align = 'end',
  sideOffset = 4,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-36 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--ui-shadow-overlay) outline-none animate-in fade-in-0 zoom-in-95',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Primitive.Separator>) {
  return (
    <Primitive.Separator
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}
