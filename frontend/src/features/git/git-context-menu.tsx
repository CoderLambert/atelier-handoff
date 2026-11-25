/**
 * @file 提供通用右键上下文菜单组件与屏幕边缘防截断计算。
 * @implementation 挂载到 body 顶层，计算边界并自动向上/向左翻转，支持点击外部和 Escape 自动关闭。
 * @updated 2026-11-25T03:35:00+08:00
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computeContextMenuCoords } from './git-coords';

export { computeContextMenuCoords };

export interface GitContextMenuItem {
  label: string;
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
  onClick?: () => void;
}

export interface GitContextMenuProps {
  x: number;
  y: number;
  items: GitContextMenuItem[];
  onClose: () => void;
}

export function GitContextMenu({ x, y, items, onClose }: GitContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; top: number; visible: boolean }>({
    left: x,
    top: y,
    visible: false,
  });

  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const { left, top } = computeContextMenuCoords(
      x,
      y,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight,
    );
    setCoords({ left, top, visible: true });
  }, [x, y]);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="git-context-menu"
      style={{
        left: `${coords.left}px`,
        top: `${coords.top}px`,
        opacity: coords.visible ? 1 : 0,
        pointerEvents: coords.visible ? 'auto' : 'none',
      }}
    >
      {items.map((item, index) => {
        if (item.divider) {
          return <div key={`divider-${index}`} className="git-context-menu-divider" role="separator" />;
        }
        const Icon = item.icon;
        return (
          <button
            key={`${item.label}-${index}`}
            type="button"
            role="menuitem"
            className={`git-context-menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick?.();
            }}
          >
            {Icon && <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden={true} />}
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
