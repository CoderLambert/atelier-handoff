/**
 * @file 通过 shadcn Select 展示受控的简单选项。
 * @implementation 保留空值、禁用项与已移除的选择，使用主题弹层和键盘导航。
 * @updated 2026-11-26T19:15:50+08:00
 */
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/components/ui/utils';

export type SelectOption<Value extends string = string> = {
  value: Value;
  label: string;
  disabled?: boolean;
};

export function OptionsSelect<Value extends string>({
  value,
  options,
  onValueChange,
  disabled,
  required,
  placeholder,
  className,
  size,
  ...triggerProps
}: {
  value: Value;
  options: readonly SelectOption<Value>[];
  onValueChange?: (value: Value) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  className?: string;
  size?: 'sm' | 'default';
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  // Radix reserves an empty string for its placeholder. A selectable empty
  // business value (such as “all projects”) still needs a non-empty item value.
  const selected = options.find((option) => option.value === value);
  const label = selected?.label ?? placeholder ?? options[0]?.label;
  return (
    <Select
      value={required && value === '' ? '' : ':' + value}
      disabled={disabled || options.length === 0}
      required={required}
      onValueChange={(key) => {
        const option = options.find(({ value }) => ':' + value === key);
        if (option && !option.disabled) onValueChange?.(option.value);
      }}
    >
      <SelectTrigger
        {...triggerProps}
        size={size}
        title={label}
        className={cn('max-w-full *:data-[slot=select-value]:min-w-0', className)}
      >
        <SelectValue placeholder={label}>
          <span className="min-w-0 truncate">{label}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="start"
        className="max-w-(--radix-select-content-available-width)"
      >
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={':' + option.value}
              disabled={option.disabled}
              title={option.label}
              className="[&>span:last-child]:min-w-0"
            >
              <span className="min-w-0 truncate">{option.label}</span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
