/**
 * @file 记忆化渲染侧栏单条会话及分支树节点。
 * @implementation 按需递归渲染展开的子分支行，复用共享运行状态词条、格式化基准时间和菜单边界容器。
 * @updated 2026-11-27T22:25:00+08:00
 */
import { memo } from 'react';
import { Archive, ChevronDown, ChevronRight, GitBranch, History } from 'lucide-react';
import type { Run, RunStatus, Session } from '@shared/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { useUiTranslation } from '@/i18n';
import { formatSessionTime } from '@/utils/format';
import type { SessionNode } from './session-tree';
import { SidebarSessionMenu, type SessionAction } from './sidebar-session-menu';

export interface SidebarSessionRowProps {
  readonly node: SessionNode;
  readonly selected: string | undefined;
  readonly selectedPath: readonly string[];
  readonly filter: string;
  readonly treeId: string;
  readonly depth?: number;
  readonly bySession: ReadonlyMap<string, Run>;
  readonly unseenOutcomes: Readonly<Record<string, RunStatus | undefined>>;
  readonly closedBranches: ReadonlyMap<string, string | undefined>;
  readonly runStatus: Readonly<Partial<Record<RunStatus | 'idle', string>>>;
  readonly menuBoundary: HTMLElement | null;
  readonly now: Date;
  readonly onSession: (id: string) => void;
  readonly onSessionAction?: (type: SessionAction, session: Session) => void;
  readonly onToggleBranch: (sessionId: string, expanded: boolean) => void;
}

export const SidebarSessionRow = memo(function SidebarSessionRow({
  node: { session, children, priorVersion },
  selected,
  selectedPath,
  filter,
  treeId,
  depth = 0,
  bySession,
  unseenOutcomes,
  closedBranches,
  runStatus,
  menuBoundary,
  now,
  onSession,
  onSessionAction,
  onToggleBranch,
}: SidebarSessionRowProps) {
  const { t, locale } = useUiTranslation('navigation');
  const active = bySession.get(session.id);
  const archived = session.status === 'archived';
  const unseen = selected === session.id ? undefined : unseenOutcomes[session.id];
  const status = active?.status ?? unseen ?? 'idle';
  const statusLabel = runStatus[status] ?? t('status.idle');
  const updatedAt = new Date(session.updatedAt);
  const branchLabel = priorVersion
    ? t('session.priorVersion')
    : session.fork && !session.fork.kind
      ? t('session.branch')
      : undefined;
  const BranchIcon = priorVersion ? History : GitBranch;
  const dot =
    archived || status === 'idle' ? null : (
      <span className="sidebar-session-status" title={statusLabel} aria-hidden="true" />
    );
  const hasChildren = children.length > 0;
  const revealSelected =
    selectedPath.includes(session.id) && closedBranches.get(session.id) !== selected;
  const expanded =
    hasChildren && (Boolean(filter) || revealSelected || !closedBranches.has(session.id));
  const groupId = `${treeId}-branches-${session.id}`;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <li data-session-node={session.id}>
      <div
        className="history-node-row sidebar-session-row"
        data-selected={selected === session.id || undefined}
        data-status={archived ? undefined : status}
        data-has-children={hasChildren || undefined}
        data-has-status={Boolean(dot) || undefined}
      >
        {hasChildren ? (
          <Button
            size="icon-sm"
            variant="ghost"
            className="history-disclosure"
            aria-expanded={expanded}
            aria-controls={groupId}
            aria-label={t(expanded ? 'session.collapseBranches' : 'session.expandBranches', {
              title: session.title,
            })}
            title={t(expanded ? 'session.collapseBranches' : 'session.expandBranches', {
              title: session.title,
            })}
            disabled={Boolean(filter)}
            onClick={() => onToggleBranch(session.id, expanded)}
          >
            <Chevron data-icon="inline-start" aria-hidden="true" />
            {dot}
          </Button>
        ) : null}
        <button
          type="button"
          className={cn('history-item', selected === session.id && 'selected')}
          aria-current={selected === session.id ? 'page' : undefined}
          onClick={() => onSession(session.id)}
        >
          {hasChildren ? null : dot}
          <span className="history-title truncate" title={session.title}>
            {session.title}
          </span>
          <span className="history-meta">
            {branchLabel ? (
              <span className="history-meta-icon" title={branchLabel}>
                <BranchIcon aria-hidden="true" />
                <span className="sr-only">{branchLabel}</span>
              </span>
            ) : null}
            {archived ? (
              <span className="history-meta-icon" title={t('session.archived')}>
                <Archive aria-hidden="true" />
                <span className="sr-only">{t('session.archived')}</span>
              </span>
            ) : (
              <time dateTime={session.updatedAt} title={updatedAt.toLocaleString(locale)}>
                {formatSessionTime(updatedAt, now, locale)}
              </time>
            )}
          </span>
          {archived ? null : <span className="sr-only">{statusLabel}</span>}
        </button>
        {onSessionAction ? (
          <SidebarSessionMenu
            session={session}
            onAction={onSessionAction}
            boundary={menuBoundary}
          />
        ) : null}
      </div>
      {hasChildren ? (
        <ul
          id={groupId}
          className="history-tree history-branches"
          data-indent={depth < 3 || undefined}
          hidden={!expanded}
        >
          {expanded
            ? children.map((child) => (
                <SidebarSessionRow
                  key={child.session.id}
                  node={child}
                  selected={selected}
                  selectedPath={selectedPath}
                  filter={filter}
                  treeId={treeId}
                  depth={depth + 1}
                  bySession={bySession}
                  unseenOutcomes={unseenOutcomes}
                  closedBranches={closedBranches}
                  runStatus={runStatus}
                  menuBoundary={menuBoundary}
                  now={now}
                  onSession={onSession}
                  onSessionAction={onSessionAction}
                  onToggleBranch={onToggleBranch}
                />
              ))
            : null}
        </ul>
      ) : null}
    </li>
  );
});
