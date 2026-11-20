/**
 * @file 定义项目桌面浏览器授权查询键。
 * @implementation 按项目隔离授权快照，并为授权修改提供稳定的 mutation key。
 * @updated 2026-11-20T11:57:56+08:00
 */
export const browserKeys = {
  desktopAccess: (projectId: string | undefined) => ['desktop-browser', projectId] as const,
  updateDesktopAccess: ['desktop-browser', 'update'] as const,
};
