/**
 * @file 解析会话工具面板与背景内容路由。
 * @implementation Browser 与 Terminal 共用同会话返回白名单，兼容旧 Browser 历史记录。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { isWorkspaceLocation, workspaceSessionId } from '@shared/workspace-location';
export type RoutePanel = 'browser' | 'terminal';
export function panelLocation(
  pathname: string,
  sessionId: string | undefined,
  state: {
    workspacePanelReturn?: string;
    workspaceBrowserReturn?: string;
    workspacePanelReturnIndex?: number;
    __TSR_index?: number;
  },
) {
  const routePanel: RoutePanel | undefined = pathname.endsWith('/browser')
    ? 'browser'
    : pathname.endsWith('/terminal')
      ? 'terminal'
      : undefined;
  const candidate = state.workspacePanelReturn ?? state.workspaceBrowserReturn;
  const returnPath =
    candidate &&
    isWorkspaceLocation(candidate) &&
    workspaceSessionId(candidate) === sessionId &&
    !candidate.endsWith('/browser') &&
    !candidate.endsWith('/terminal')
      ? candidate
      : undefined;
  const previousIndex = state.workspacePanelReturnIndex;
  const canReturnBack = Boolean(
    returnPath &&
    previousIndex !== undefined &&
    previousIndex >= 0 &&
    Number.isSafeInteger(previousIndex) &&
    state.__TSR_index === previousIndex + 1,
  );
  return {
    routePanel,
    returnPath,
    canReturnBack,
    contentPath: routePanel ? (returnPath ?? `/sessions/${sessionId}`) : pathname,
  };
}
