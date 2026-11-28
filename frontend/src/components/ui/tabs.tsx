/**
 * @file 提供可复用的标签页原语，支持下划线式与胶囊式两种视觉变体。
 * @implementation 基于 React Context 与标准 ARIA tablist/tab/tabpanel 语义实现，内置键盘左右、Home、End 切换。
 * @updated 2026-11-28T00:08:00+08:00
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils';

type TabsVariant = 'underline' | 'pill';

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
  variant: TabsVariant;
  baseId: string;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) {
    throw new Error(`${component} must be rendered inside <Tabs>.`);
  }
  return ctx;
}

const tabsListVariants = cva('inline-flex items-center', {
  variants: {
    variant: {
      underline: 'gap-5 border-b border-border',
      pill: 'gap-1 rounded-lg bg-muted p-1',
    },
  },
  defaultVariants: {
    variant: 'underline',
  },
});

const tabsTriggerVariants = cva(
  [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-[13px] font-medium',
    'transition-[background-color,color,border-color] duration-(--motion-feedback) ease-(--ease-standard) motion-reduce:transition-none',
    'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&>svg]:pointer-events-none [&>svg]:size-3.5 [&>svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        underline: [
          'relative -mb-px border-b-2 border-transparent px-0.5 py-2 text-muted-foreground',
          'hover:text-foreground',
          'data-[state=active]:border-primary data-[state=active]:font-semibold data-[state=active]:text-foreground',
        ],
        pill: [
          'min-h-(--ui-size-xs) rounded-md px-2.5 py-1 text-muted-foreground',
          'hover:text-foreground',
          'data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs',
        ],
      },
    },
    defaultVariants: {
      variant: 'underline',
    },
  },
);

export interface TabsProps
  extends Omit<React.ComponentProps<'div'>, 'defaultValue'>, VariantProps<typeof tabsListVariants> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

function Tabs({
  value: controlledValue,
  defaultValue = '',
  onValueChange,
  variant = 'underline',
  className,
  ...props
}: TabsProps) {
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue);
  const value = controlledValue ?? uncontrolledValue;
  const baseId = React.useId();

  const handleValueChange = React.useCallback(
    (next: string) => {
      if (controlledValue === undefined) {
        setUncontrolledValue(next);
      }
      onValueChange?.(next);
    },
    [controlledValue, onValueChange],
  );

  const ctx = React.useMemo<TabsContextValue>(
    () => ({
      value,
      onValueChange: handleValueChange,
      variant: variant ?? 'underline',
      baseId,
    }),
    [value, handleValueChange, variant, baseId],
  );

  return (
    <TabsContext.Provider value={ctx}>
      <div data-slot="tabs" className={cn('flex flex-col', className)} {...props} />
    </TabsContext.Provider>
  );
}

function TabsList({ className, onKeyDown, ...props }: React.ComponentProps<'div'>) {
  const { variant } = useTabsContext('TabsList');

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const triggers = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
    );
    if (triggers.length === 0) return;
    const currentIndex = triggers.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex === -1) return;
    event.preventDefault();
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % triggers.length;
    else if (event.key === 'ArrowLeft')
      nextIndex = (currentIndex - 1 + triggers.length) % triggers.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = triggers.length - 1;
    const target = triggers[nextIndex];
    target?.focus();
    target?.click();
  };

  return (
    <div
      role="tablist"
      data-slot="tabs-list"
      data-variant={variant}
      onKeyDown={handleKeyDown}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

export interface TabsTriggerProps extends React.ComponentProps<'button'> {
  value: string;
}

function TabsTrigger({ value, className, onClick, ...props }: TabsTriggerProps) {
  const { value: activeValue, onValueChange, variant, baseId } = useTabsContext('TabsTrigger');
  const isActive = activeValue === value;

  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-selected={isActive}
      aria-controls={`${baseId}-panel-${value}`}
      tabIndex={isActive ? 0 : -1}
      data-slot="tabs-trigger"
      data-state={isActive ? 'active' : 'inactive'}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onValueChange(value);
        }
      }}
      className={cn(tabsTriggerVariants({ variant }), className)}
      {...props}
    />
  );
}

export interface TabsContentProps extends React.ComponentProps<'div'> {
  value: string;
}

function TabsContent({ value, className, ...props }: TabsContentProps) {
  const { value: activeValue, baseId } = useTabsContext('TabsContent');
  if (activeValue !== value) return null;

  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      data-slot="tabs-content"
      className={cn('outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
