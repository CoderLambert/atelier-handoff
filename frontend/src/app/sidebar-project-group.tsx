/**
 * @file 记忆化渲染侧栏单个项目分组及其会话树与分页控件。
 * @implementation 维护单项目折叠、分页与新建会话入口，仅在所属项目或共享状态变化时重渲染对应分组。
 * @updated 2026-11-27T22:25:00+08:00
 */
import { memo } from 'react';
import { ChevronDown, ChevronRight, FolderOpen, Plus } from 'lucide-react';
import type { Run, RunStatus, Session } from '@shared/types';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import {
  paginateSessionTree,
  type ProjectSessionGroup,
  type SessionTreePagination,
} from './session-tree';
import type { SessionAction } from './sidebar-session-menu';
import { SidebarSessionRow } from './sidebar-session-row';

export interface SidebarProjectGroupProps {
  readonly group: ProjectSessionGroup;
  readonly selected: string | undefined;
  readonly filter: string;
  readonly treeId: string;
  readonly activeProjectId: string | undefined;
  readonly sessionsLoaded: boolean;
  readonly pagination: SessionTreePagination | undefined;
  readonly closedSelection: string | undefined;
  readonly hasClosedEntry: boolean;
  readonly numberFormat: Intl.NumberFormat;
  readonly bySession: ReadonlyMap<string, Run>;
  readonly unseenOutcomes: Readonly<Record<string, RunStatus | undefined>>;
  readonly closedBranches: ReadonlyMap<string, string | undefined>;
  readonly runStatus: Readonly<Partial<Record<RunStatus | 'idle', string>>>;
  readonly menuBoundary: HTMLElement | null;
  readonly now: Date;
  readonly onSession: (id: string) => void;
  readonly onSessionAction?: (type: SessionAction, session: Session) => void;
  readonly onNew: () => void;
  readonly onNewProject?: (projectId: string) => void;
  readonly onToggleProject: (projectId: string, expanded: boolean) => void;
  readonly onToggleBranch: (sessionId: string, expanded: boolean) => void;
  readonly onPageChange: (projectId: string, page: number) => void;
}

export const SidebarProjectGroup = memo(function SidebarProjectGroup({
  group,
  selected,
  filter,
  treeId,
  activeProjectId,
  sessionsLoaded,
  pagination,
  closedSelection,
  hasClosedEntry,
  numberFormat,
  bySession,
  unseenOutcomes,
  closedBranches,
  runStatus,
  menuBoundary,
  now,
  onSession,
  onSessionAction,
  onNew,
  onNewProject,
  onToggleProject,
  onToggleBranch,
  onPageChange,
}: SidebarProjectGroupProps) {
  const { t } = useUiTranslation('navigation');
  const page = paginateSessionTree(group.nodes, selected, filter, pagination);
  const revealSelected = page.selectedPath.length > 0 && closedSelection !== selected;
  const expanded = Boolean(filter) || revealSelected || !hasClosedEntry;
  const projectTitle =
    group.project?.name ?? t('sidebar.unavailableProject', { id: group.projectId });
  const groupId = `${treeId}-project-${group.projectId}`;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const canCreate =
    group.project?.available && (onNewProject || activeProjectId === group.projectId);

  return (
    <section
      className="sidebar-project"
      data-project-id={group.projectId}
      aria-label={projectTitle}
    >
      <div className="sidebar-project-heading">
        <button
          type="button"
          className="sidebar-project-toggle"
          aria-expanded={expanded}
          aria-controls={groupId}
          title={group.project?.path ?? projectTitle}
          onClick={() => onToggleProject(group.projectId, expanded)}
          disabled={Boolean(filter)}
        >
          <Chevron aria-hidden="true" />
          <FolderOpen aria-hidden="true" />
          <span className="truncate">{projectTitle}</span>
          <span className="sidebar-project-count">{numberFormat.format(group.sessionCount)}</span>
        </button>
        {canCreate ? (
          <Button
            size="icon-sm"
            variant="ghost"
            className="sidebar-project-new"
            aria-label={t('sidebar.newProjectSession', { title: projectTitle })}
            title={t('sidebar.newProjectSession', { title: projectTitle })}
            onClick={() => (onNewProject ? onNewProject(group.projectId) : onNew())}
          >
            <Plus aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div id={groupId} hidden={!expanded}>
        {group.archivedCount > 0 ? (
          <p className="sidebar-archive-summary">
            {t('sidebar.archivedSessions', {
              count: group.archivedCount,
              countText: numberFormat.format(group.archivedCount),
            })}
          </p>
        ) : null}
        {group.project && !group.project.available ? (
          <p className="sidebar-project-empty">{t('sidebar.projectUnavailable')}</p>
        ) : null}
        {!group.nodes.length && sessionsLoaded ? (
          <p className="sidebar-project-empty">{t('sidebar.noSessions')}</p>
        ) : null}
        {group.nodes.length > 0 ? (
          <ul
            className="history-tree"
            aria-label={t('sidebar.sessionTree', { title: projectTitle })}
          >
            {page.nodes.map((node) => (
              <SidebarSessionRow
                key={node.session.id}
                node={node}
                selected={selected}
                selectedPath={page.selectedPath}
                filter={filter}
                treeId={treeId}
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
            ))}
          </ul>
        ) : null}
        {page.lastPage > 0 ? (
          <div
            className="sidebar-pagination"
            aria-label={t('sidebar.sessionPagination', { title: projectTitle })}
          >
            <Button
              size="sm"
              variant="ghost"
              disabled={page.page === 0}
              onClick={() => onPageChange(group.projectId, page.page - 1)}
            >
              {t('sidebar.previousPage')}
            </Button>
            <span>
              {t('sidebar.page', {
                page: numberFormat.format(page.page + 1),
                total: numberFormat.format(page.lastPage + 1),
              })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={page.page === page.lastPage}
              onClick={() => onPageChange(group.projectId, page.page + 1)}
            >
              {t('sidebar.nextPage')}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
});
