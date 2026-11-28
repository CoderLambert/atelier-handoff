/**
 * @file 提供全站统一的空状态与分隔线基础原语。
 * @implementation 规范图标、标题、说明与主操作的居中排版和细分隔线样式，减少各模块重复手写空态。
 * @updated 2026-11-28T00:08:00+08:00
 */
import * as React from 'react';
import { cn } from './utils';

export interface EmptyStateProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

function EmptyState({ icon, title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-border bg-card/50 px-6 py-12 text-center',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground [&>svg]:size-5"
        >
          {icon}
        </div>
      ) : null}
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {description ? (
        <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

function Separator({
  orientation = 'horizontal',
  className,
  ...props
}: React.ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical' }) {
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      data-slot="separator"
      className={cn(
        'shrink-0 bg-border-subtle',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}

export { EmptyState, Separator };
