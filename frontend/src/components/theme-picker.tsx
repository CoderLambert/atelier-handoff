/**
 * @file 提供工作台主题选择与带有视觉微缩预览的弹出列表。
 * @implementation 支持黑曜工作室、工坊经典与暖纸书卷的实时切换，展示各主题迷你窗口预览与双语说明。
 * @updated 2026-11-23T13:15:00+08:00
 */
import { Check, ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useUiTranslation } from '@/i18n';
import { useUiTheme, type UiTheme } from '@/theme';

export function ThemePreviewSwatch({ theme }: { theme: UiTheme }) {
  return (
    <div className="theme-preview-swatch" data-theme={theme} aria-hidden="true">
      <div className="swatch-sidebar">
        <span className="swatch-dot" />
        <span className="swatch-bar" />
      </div>
      <div className="swatch-main">
        <div className="swatch-header" />
        <div className="swatch-card">
          <span className="swatch-line" />
          <span className="swatch-accent" />
        </div>
      </div>
    </div>
  );
}

export function ThemePicker({
  triggerId,
  align = 'end',
  side = 'bottom',
  children,
}: {
  triggerId?: string;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  children?: ReactNode;
}) {
  const { t } = useUiTranslation('inspector');
  const { theme, setTheme } = useUiTheme();
  const [open, setOpen] = useState(false);

  const themes = [
    { id: 'obsidian' as const, titleKey: 'layout.themeObsidian' as const, descKey: 'layout.themeObsidianDesc' as const },
    { id: 'classic' as const, titleKey: 'layout.themeClassic' as const, descKey: 'layout.themeClassicDesc' as const },
    { id: 'parchment' as const, titleKey: 'layout.themeParchment' as const, descKey: 'layout.themeParchmentDesc' as const },
    { id: 'nordic' as const, titleKey: 'layout.themeNordic' as const, descKey: 'layout.themeNordicDesc' as const },
    { id: 'rose' as const, titleKey: 'layout.themeRose' as const, descKey: 'layout.themeRoseDesc' as const },
    { id: 'midnight' as const, titleKey: 'layout.themeMidnight' as const, descKey: 'layout.themeMidnightDesc' as const },
  ];

  const matched = themes.find((entry) => entry.id === theme);
  const currentTitle = matched ? t(matched.titleKey) : t('layout.themeObsidian');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {children ? (
          children
        ) : (
          <button
            type="button"
            id={triggerId}
            className="theme-picker-trigger"
            aria-label={t('layout.themeSelectTitle')}
          >
            <div className="theme-picker-trigger-label">
              <ThemePreviewSwatch theme={theme} />
              <span className="font-medium truncate">{currentTitle}</span>
            </div>
            <ChevronDown className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align={align} side={side} className="theme-picker-popover-content">
        <div className="theme-picker-popover-header">{t('layout.themeSelectTitle')}</div>
        <div className="theme-picker-list" role="listbox" aria-label={t('layout.themeLabel')}>
          {themes.map((entry) => {
            const isSelected = theme === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-selected={isSelected}
                className="theme-picker-item"
                onClick={() => {
                  setTheme(entry.id);
                  setOpen(false);
                }}
              >
                <div className="theme-picker-item-left">
                  <ThemePreviewSwatch theme={entry.id} />
                  <div className="theme-picker-item-copy">
                    <span className="theme-picker-item-title">{t(entry.titleKey)}</span>
                    <span className="theme-picker-item-desc">{t(entry.descKey)}</span>
                  </div>
                </div>
                {isSelected ? (
                  <Check className="size-4 text-primary shrink-0" aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
