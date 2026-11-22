/**
 * @file 提供侧栏会话操作菜单。
 * @implementation 使用 Radix 菜单限制弹层边界，并在菜单关闭后交付重命名、归档、恢复或删除动作。
 * @updated 2026-11-23T04:53:58+08:00
 */
import { useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Archive, ArchiveRestore, Ellipsis, Pencil, Trash2 } from 'lucide-react';
import type { Session } from '@shared/types';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';

export type SessionAction = 'rename' | 'archive' | 'restore' | 'delete';

/** Keep menus within the sidebar, clear the menu focus scope before opening a dialog. */
export function SidebarSessionMenu({
  session,
  onAction,
  boundary,
}: {
  session: Session;
  onAction: (type: SessionAction, session: Session) => void;
  boundary: HTMLElement | null;
}) {
  const { t } = useUiTranslation('navigation');
  const pendingAction = useRef<SessionAction | undefined>(undefined);
  const archived = session.status === 'archived';
  const ArchiveIcon = archived ? ArchiveRestore : Archive;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="sidebar-session-menu-trigger"
          aria-label={t('sessionMenu.manage', { title: session.title })}
          title={t('sessionMenu.manage', { title: session.title })}
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={boundary}>
        <DropdownMenu.Content
          className="sidebar-session-menu"
          align="end"
          sideOffset={4}
          collisionBoundary={boundary}
          collisionPadding={6}
          hideWhenDetached
          loop
          onCloseAutoFocus={() => {
            const action = pendingAction.current;
            pendingAction.current = undefined;
            if (action) queueMicrotask(() => onAction(action, session));
          }}
        >
          <DropdownMenu.Group>
            <DropdownMenu.Item
              className="sidebar-session-menu-item"
              onSelect={() => {
                pendingAction.current = 'rename';
              }}
            >
              <Pencil aria-hidden="true" />
              {t('sessionMenu.rename')}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="sidebar-session-menu-item"
              onSelect={() => {
                pendingAction.current = archived ? 'restore' : 'archive';
              }}
            >
              <ArchiveIcon aria-hidden="true" />
              {archived ? t('sessionMenu.restore') : t('sessionMenu.archive')}
            </DropdownMenu.Item>
          </DropdownMenu.Group>
          <DropdownMenu.Separator className="sidebar-session-menu-separator" />
          <DropdownMenu.Group>
            <DropdownMenu.Item
              className="sidebar-session-menu-item"
              data-variant="destructive"
              onSelect={() => {
                pendingAction.current = 'delete';
              }}
            >
              <Trash2 aria-hidden="true" />
              {t('sessionMenu.delete')}
            </DropdownMenu.Item>
          </DropdownMenu.Group>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
