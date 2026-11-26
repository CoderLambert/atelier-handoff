/**
 * @file 定义工作区导航、路由加载和缺省页面。
 * @implementation 装配哈希路由，并用界面语言展示加载及未找到状态。
 * @updated 2026-11-22T22:58:24+08:00
 */
import { lazy, Suspense } from 'react';
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';

import { useUiTranslation } from '@/i18n';

const Workspace = lazy(() => import('./workspace'));

function WorkspaceRoute() {
  const { t } = useUiTranslation('workbench');
  return (
    <Suspense fallback={<p role="status">{t('route.opening')}</p>}>
      <Workspace />
    </Suspense>
  );
}

function NotFoundRoute() {
  const { t } = useUiTranslation('workbench');
  return (
    <p className="p-6" role="alert">
      {t('route.notFound')} <a href="#/sessions">{t('route.openSessions')}</a>
    </p>
  );
}

const root = createRootRoute({ component: WorkspaceRoute, notFoundComponent: NotFoundRoute });

function page<const Path extends string>(path: Path) {
  return createRoute({ getParentRoute: () => root, path });
}

const routeTree = root.addChildren([
  page('/'),
  page('/sessions'),
  page('/sessions/$sessionId'),
  page('/sessions/$sessionId/trace'),
  page('/sessions/$sessionId/trace/$runId'),
  page('/sessions/$sessionId/artifacts'),
  page('/sessions/$sessionId/browser'),
  page('/sessions/$sessionId/terminal'),
  page('/sessions/$sessionId/messages/$messageId'),
  page('/runs'),
  page('/artifacts'),
  page('/extensions'),
  page('/agents'),
  createRoute({
    getParentRoute: () => root,
    path: '/settings',
    beforeLoad: () => {
      throw redirect({ to: '/settings/models', replace: true });
    },
  }),
  page('/settings/models'),
  page('/settings/layout'),
  page('/settings/notifications'),
  page('/settings/diagnostics'),
]);
export const workspaceRouter = createRouter({ routeTree, history: createHashHistory() });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof workspaceRouter;
  }
}
