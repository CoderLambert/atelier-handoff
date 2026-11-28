/**
 * @file 提供工作区路由解析、启动恢复、删会话回退与布局覆盖的纯状态流转。
 * @implementation 将无副作用的布局覆盖释放、视图/标签判定和会话落点选择抽离为纯函数，便于工作区与测试共用。
 * @updated 2026-11-27T19:25:00+08:00
 */
import type { Project, Session } from '@shared/types';
import { initialWorkspaceLayout, type WorkspaceLayout } from '@shared/workspace-layout';
import { isWorkspaceLocation, workspaceSessionId } from '@shared/workspace-location';
import { sessionSwitchItems } from './session-switcher-model';
import type { Tab, View } from './store';
import type { SettingsSection } from './types';

export const collectionPaths = {
  runs: '/runs',
  artifacts: '/artifacts',
  extensions: '/extensions',
  agents: '/agents',
  schedules: '/schedules',
} as const;

export const settingsPaths = {
  models: '/settings/models',
  layout: '/settings/layout',
  shortcuts: '/settings/shortcuts',
  notifications: '/settings/notifications',
  diagnostics: '/settings/diagnostics',
} as const;

export function currentView(pathname: string): View {
  if (pathname.startsWith('/settings/')) return 'settings';
  return (
    (Object.keys(collectionPaths) as (keyof typeof collectionPaths)[]).find(
      (view) => collectionPaths[view] === pathname,
    ) ?? 'chat'
  );
}

export function sessionTab(contentPath: string, sessionId?: string): Tab {
  if (contentPath.includes('/trace')) return 'trace';
  if (sessionId && contentPath.endsWith('/artifacts')) return 'artifacts';
  return 'conversation';
}

export function settingsSection(pathname: string): SettingsSection {
  if (pathname === settingsPaths.layout) return 'layout';
  if (pathname === settingsPaths.shortcuts) return 'shortcuts';
  if (pathname === settingsPaths.notifications) return 'notifications';
  if (pathname === settingsPaths.diagnostics) return 'diagnostics';
  return 'models';
}

export type InitialWorkspaceRoute =
  | { kind: 'replace-raw'; path: string }
  | { kind: 'session'; sessionId: string; openProjects: boolean }
  | { kind: 'sessions'; openProjects: boolean };

export function resolveInitialWorkspaceRoute(
  ready: {
    workspaceLocation?: string | null;
    workspaceLastSession?: string | null;
    sessions: readonly Pick<Session, 'id' | 'status'>[];
    projects: readonly unknown[];
  },
  rememberedSessionId?: string | null,
): InitialWorkspaceRoute {
  const saved = ready.workspaceLocation;
  const savedId = saved ? workspaceSessionId(saved) : undefined;
  if (
    saved &&
    isWorkspaceLocation(saved) &&
    (!savedId || ready.sessions.some(({ id }) => id === savedId))
  ) {
    return { kind: 'replace-raw', path: saved };
  }
  const previous = ready.workspaceLastSession ?? rememberedSessionId ?? undefined;
  const restored =
    ready.sessions.find(({ id }) => id === previous) ??
    ready.sessions.find(({ status }) => status === 'active') ??
    ready.sessions[0];
  const openProjects = ready.projects.length === 0;
  if (restored) {
    return { kind: 'session', sessionId: restored.id, openProjects };
  }
  return { kind: 'sessions', openProjects };
}

export function selectSessionAfterDelete(
  sessions: readonly Pick<Session, 'id' | 'projectId' | 'status'>[],
  deleted: Pick<Session, 'id' | 'projectId'>,
): string | undefined {
  const remaining = sessions.filter(({ id }) => id !== deleted.id);
  const next =
    remaining.find((item) => item.projectId === deleted.projectId && item.status === 'active') ??
    remaining[0];
  return next?.id;
}

export interface PendingLayoutOverride {
  requestId: number;
  layout: WorkspaceLayout;
}

export function applyLayoutOverride(
  current: PendingLayoutOverride | undefined,
  layout: WorkspaceLayout,
): PendingLayoutOverride {
  return { requestId: (current?.requestId ?? 0) + 1, layout };
}

export function releaseLayoutOverride(
  current: PendingLayoutOverride | undefined,
  requestId: number,
): PendingLayoutOverride | undefined {
  return current?.requestId === requestId ? undefined : current;
}

export function resolveWorkspaceLayout(
  override: PendingLayoutOverride | undefined,
  serverLayout: WorkspaceLayout | undefined,
): WorkspaceLayout {
  return override?.layout ?? serverLayout ?? initialWorkspaceLayout;
}

export function composerSession(
  bootstrap: { sessions: readonly Session[]; projects: readonly Project[] } | undefined,
  sessionId?: string,
  lastId?: string | null,
) {
  if (!bootstrap) return;
  const { sessions, projects } = bootstrap;
  if (sessionId) return sessions.find(({ id }) => id === sessionId);
  return (
    sessions.find(({ id, status }) => id === lastId && status === 'active') ??
    sessionSwitchItems(sessions, projects, '').find(({ session }) => session.status === 'active')
      ?.session
  );
}
