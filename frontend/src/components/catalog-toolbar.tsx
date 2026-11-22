/**
 * @file 组合目录页面的项目选择、搜索、状态过滤和操作区域。
 * @implementation 接收受控值、选项和语义回调，在智能体与扩展目录中复用原生表单标签、主题样式及响应式排布。
 * @updated 2026-11-23T04:58:09+08:00
 */
import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/utils';

type CatalogOption = { value: string; label: string };

const selectClassName =
  'h-9 min-w-0 max-w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50';

export function CatalogProjectSelect({
  label,
  selectLabel,
  value,
  options,
  emptyLabel,
  disabled,
  className,
  onValueChange,
}: {
  label: string;
  selectLabel: string;
  value: string;
  options: readonly CatalogOption[];
  emptyLabel: string;
  disabled?: boolean;
  className?: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <label
      data-slot="catalog-project-select"
      className={cn(
        'grid w-full min-w-0 gap-1.5 text-xs text-muted-foreground min-[761px]:w-60 min-[761px]:shrink-0',
        className,
      )}
    >
      {label}
      <select
        aria-label={selectLabel}
        className={selectClassName}
        disabled={disabled}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {options.length ? (
          options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))
        ) : (
          <option value="">{emptyLabel}</option>
        )}
      </select>
    </label>
  );
}

export function CatalogToolbar({
  search,
  filter,
  className,
  children,
}: {
  search: {
    label: string;
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
  };
  filter: {
    label: string;
    value: string;
    options: readonly CatalogOption[];
    onChange: (value: string) => void;
  };
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="catalog-toolbar"
      className={cn('flex flex-wrap items-center gap-3 py-5', className)}
    >
      <label className="flex h-9 min-w-0 basis-44 grow items-center gap-2 rounded-md border border-input bg-background px-3 text-muted-foreground focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring min-[761px]:max-w-85">
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <input
          type="search"
          aria-label={search.label}
          placeholder={search.placeholder}
          value={search.value}
          onChange={(event) => search.onChange(event.target.value)}
          className="w-full min-w-0 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        {filter.label}
        <select
          className={selectClassName}
          value={filter.value}
          onChange={(event) => filter.onChange(event.target.value)}
        >
          {filter.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-2 min-[1000px]:ms-auto">{children}</div>
    </div>
  );
}
