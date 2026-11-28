/**
 * @file 提供全站管理配置页统一的顶部页头原语。
 * @implementation 规范图标徽章、主标题、一句话说明与右侧操作区的布局比例和底部分隔线。
 * @updated 2026-11-28T00:08:00+08:00
 */
import * as React from 'react';
import { cn } from './utils';

export interface PageHeaderProps extends Omit<React.ComponentProps<'header'>, 'title'> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}

function PageHeader({ icon, title, description, actions, className, ...props }: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        'flex flex-wrap items-center justify-between gap-4 border-b border-border-subtle pb-5',
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-3.5">
        {icon ? (
          <div
            aria-hidden="true"
            className="flex size-11 shrink-0 items-center justify-center rounded-[14px] border border-primary/20 bg-primary/10 text-primary shadow-xs [&>svg]:size-5"
          >
            {icon}
          </div>
        ) : null}
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description ? (
            <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div>
      ) : null}
    </header>
  );
}

export { PageHeader };
