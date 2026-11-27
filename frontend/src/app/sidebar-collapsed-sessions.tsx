/**
 * @file 提供侧栏收缩态下的最近会话下拉菜单分组。
 * @implementation 复用工作区排序后的最近会话列表，展示标题、所属项目、当前选中与运行状态，并支持打开全部会话切换器。
 * @updated 2026-11-28T01:35:00+08:00
 */
import { Check, MessageSquare, Search } from 'lucide-react';
import type { Run, RunStatus } from '@shared/types';
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useUiTranslation } from '@/i18n';
import type { SessionSwitchItem } from './session-switcher-model';

const maxMenuSessions = 8;

function resolveSessionStatus(
  sessionId: string,
  bySession: ReadonlyMap<string, Pick<Run, 'status'>>,
  unseenOutcomes: Readonly<Record<string, RunStatus | undefined>>,
  runStatus: Partial<Record<RunStatus | 'idle', string>>,
) {
  const activeRun = bySession.get(sessionId);
  const unseen = unseenOutcomes[sessionId];
  const status = activeRun?.status ?? unseen;
  const statusText = activeRun
    ? runStatus[activeRun.status]
    : unseen
      ? runStatus[unseen]
      : undefined;
  return { status, statusText };
}

export function CollapsedSessionMenuItems({
  recentSessions,
  selected,
  bySession,
  unseenOutcomes,
  runStatus,
  onSession,
  onOpenSwitcher,
}: {
  recentSessions: readonly SessionSwitchItem[];
  selected?: string;
  bySession: ReadonlyMap<string, Pick<Run, 'status'>>;
  unseenOutcomes: Readonly<Record<string, RunStatus | undefined>>;
  runStatus: Partial<Record<RunStatus | 'idle', string>>;
  onSession: (id: string) => void;
  onOpenSwitcher?: () => void;
}) {
  const { t } = useUiTranslation('navigation');
  return (
    <>
      {recentSessions.length > 0 ? (
        <>
          <DropdownMenuSeparator className="sidebar-session-menu-separator" />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('sidebar.recentSessions')}</DropdownMenuLabel>
            {recentSessions.slice(0, maxMenuSessions).map((item) => {
              const isSelected = item.session.id === selected;
              const { status, statusText } = resolveSessionStatus(
                item.session.id,
                bySession,
                unseenOutcomes,
                runStatus,
              );
              return (
                <DropdownMenuItem
                  key={item.session.id}
                  className="sidebar-session-menu-item sidebar-session-menu-recent"
                  onSelect={() => onSession(item.session.id)}
                >
                  {isSelected ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <MessageSquare aria-hidden="true" />
                  )}
                  <span className="sidebar-session-menu-recent-main">
                    <span className="truncate">{item.session.title}</span>
                    {item.projectName ? (
                      <span className="sidebar-session-menu-recent-project truncate">
                        {item.projectName}
                      </span>
                    ) : null}
                  </span>
                  {status && statusText ? (
                    <span
                      className="sidebar-collapsed-session-dot"
                      data-status={status}
                      title={statusText}
                      aria-label={statusText}
                    />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        </>
      ) : null}
      {onOpenSwitcher ? (
        <>
          <DropdownMenuSeparator className="sidebar-session-menu-separator" />
          <DropdownMenuGroup>
            <DropdownMenuItem
              className="sidebar-session-menu-item"
              onSelect={onOpenSwitcher}
            >
              <Search aria-hidden="true" />
              {t('sidebar.switchAllSessions')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </>
      ) : null}
    </>
  );
}
