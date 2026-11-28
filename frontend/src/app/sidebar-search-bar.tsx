/**
 * @file 渲染侧栏展开态原位会话搜索框与关闭按钮。
 * @implementation 隔离搜索输入与 IME 安全 Esc 关闭逻辑，支持聚焦传入的输入引用。
 * @updated 2026-11-27T22:25:00+08:00
 */
import { memo, type RefObject } from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import { Input } from '@/components/ui/input';

export const SidebarSearchBar = memo(function SidebarSearchBar({
  inputRef,
  value,
  onChange,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useUiTranslation('navigation');
  return (
    <>
      <label className="sidebar-search">
        <span className="sr-only">{t('sidebar.search')}</span>
        <Search aria-hidden="true" />
        <Input
          ref={inputRef}
          className="field w-full"
          type="search"
          placeholder={t('sidebar.searchPlaceholder')}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
      </label>
      <Button
        variant="ghost"
        size="icon-sm"
        className="sidebar-icon"
        aria-label={t('sidebar.closeSearch')}
        title={t('sidebar.closeSearch')}
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </>
  );
});
