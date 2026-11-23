/**
 * @file 前端路由状态扩展类型声明。
 * @implementation 集中扩展 TanStack Router 的 HistoryState。
 * @updated 2026-11-23T18:25:00+08:00
 */
declare module '@tanstack/react-router' {
  interface HistoryState {
    workspaceBrowserReturn?: string;
  }
}

export {};
