import { useEffect, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  Bot,
  Boxes,
  Clock3,
  FolderOpen,
  MessagesSquare,
  Package,
  Plus,
  Settings2,
} from 'lucide-react';
import { activeStatuses, type Project, type Run, type Session } from '@shared/types';
import { api } from '@/api/client';
import type { Page } from '@/api/types';
import { Button } from '@/components/ui/button';
import { keys } from './events';
import { type View, useWorkspace } from './store';

const links = [
  { id: 'chat', label: '全部会话', Icon: MessagesSquare },
  { id: 'artifacts', label: '交付物', Icon: Package },
  { id: 'runs', label: '执行记录', Icon: Clock3 },
  { id: 'extensions', label: '扩展', Icon: Boxes },
  { id: 'agents', label: '智能体', Icon: Bot },
] as const;
const runStatus = {
  queued: '排队中',
  running: '执行中',
  awaiting_permission: '等待审批',
  stopping: '正在停止',
};
const pageSize = 50;

export function Sidebar({
  project,
  artifactCount,
  onSession,
  onView,
  onNew,
  onProjects,
  onSettings,
}: {
  project?: Project;
  artifactCount?: number;
  onSession: (id: string) => void;
  onView: (view: View) => void;
  onNew: () => void;
  onProjects: () => void;
  onSettings: () => void;
}) {
  const current = useWorkspace((state) => state.workspace.sessionId);
  const view = useWorkspace((state) => state.workspace.view);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilter(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const sessions = useQuery({
    queryKey: [...keys.sessions, filter, offset],
    queryFn: ({ signal }) =>
      api<Page<Session>>(
        `/api/sessions?${new URLSearchParams({ includeArchived: 'true', query: filter, offset: String(offset), limit: String(pageSize) })}`,
        { signal },
      ),
  });
  const activity = useQueries({
    queries: activeStatuses.map((status) => ({
      queryKey: [...keys.runs, 'active', status],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<Page<Run>>(`/api/runs?status=${status}&limit=500`, { signal }),
    })),
  });
  const bySession = new Map(
    activity.flatMap((query) => query.data?.items ?? []).map((run) => [run.sessionId, run]),
  );
  return (
    <nav className="sidebar" aria-label="工作空间导航">
      <div className="wordmark">
        <span className="brand-symbol" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>
          atelier<span className="brand-period">.</span>
        </span>
      </div>
      <button
        type="button"
        className="workspace-switch"
        onClick={onProjects}
        aria-label="打开工作空间设置"
      >
        <span className="workspace-avatar">
          <FolderOpen size={17} />
        </span>
        <span>
          <span className="overline">工作目录</span>
          <strong>{project?.name ?? '绑定项目'}</strong>
        </span>
      </button>
      <button type="button" className="new-session" onClick={onNew}>
        <Plus size={16} />
        新建会话
      </button>
      <label className="my-3 block">
        <span className="sr-only">搜索会话</span>
        <input
          className="field w-full"
          type="search"
          placeholder="搜索会话"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className="main-nav" aria-label="主导航">
        {links.map(({ id, label, Icon }) => (
          <button
            type="button"
            key={id}
            className={`nav-item ${view === id ? 'active' : ''}`}
            aria-current={view === id ? 'page' : undefined}
            onClick={() => onView(id)}
          >
            <Icon size={16} />
            <span>{label}</span>
            {id === 'chat' ? <span className="ml-auto">{sessions.data?.total ?? 0}</span> : null}
            {id === 'artifacts' && artifactCount !== undefined ? (
              <span className="ml-auto">{artifactCount}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="sidebar-section-label">最近会话</div>
      <div className="history-wrap min-h-0 flex-1 overflow-auto">
        {sessions.isError ? (
          <Button variant="ghost" onClick={() => void sessions.refetch()}>
            会话加载失败，重试
          </Button>
        ) : null}
        {!sessions.isPending && !sessions.data?.items.length ? (
          <p className="search-empty">{filter ? '没有匹配会话' : '没有会话'}</p>
        ) : null}
        {sessions.data?.items.map((session) => {
          const active = bySession.get(session.id);
          const meta = active
            ? runStatus[active.status as keyof typeof runStatus]
            : session.status === 'archived'
              ? '已归档'
              : new Date(session.updatedAt).toLocaleString('zh-CN');
          return (
            <button
              type="button"
              key={session.id}
              className={`history-item ${current === session.id && view === 'chat' ? 'selected' : ''}`}
              onClick={() => onSession(session.id)}
            >
              <span className="history-title od-truncate">{session.title}</span>
              <span className="history-meta">{meta}</span>
            </button>
          );
        })}
        {offset || sessions.data?.nextOffset != null ? (
          <div className="flex gap-2 px-2 py-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!offset}
              onClick={() => setOffset((page) => Math.max(0, page - pageSize))}
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={sessions.data?.nextOffset == null}
              onClick={() => setOffset(sessions.data?.nextOffset ?? offset)}
            >
              下一页
            </Button>
          </div>
        ) : null}
      </div>
      <div className="sidebar-bottom">
        <Button variant="ghost" onClick={onSettings}>
          <Settings2 size={16} />
          工作台设置
        </Button>
      </div>
    </nav>
  );
}
