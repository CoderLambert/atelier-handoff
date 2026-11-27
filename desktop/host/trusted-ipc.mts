/**
 * @file 校验工作台主进程 IPC 的发送来源。
 * @implementation 每次调用复核关停状态、存活窗口、主 frame 和当前运行时 origin，并返回已校验窗口和连接。
 * @updated 2026-11-27T16:55:43+08:00
 */
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

export function createTrustedIpcGuard<Connection extends { origin: string }>(
  getWindow: () => BrowserWindow | undefined,
  getConnection: () => Connection | undefined,
  isStopping: () => boolean,
  invalidSource: () => string,
) {
  return function assertTrustedIpc(event: IpcMainInvokeEvent) {
    const owner = getWindow();
    const connection = getConnection();
    if (isStopping() || !owner || owner.isDestroyed() || !connection)
      throw new Error(invalidSource());

    const contents = owner.webContents;
    if (
      contents.isDestroyed() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      event.senderFrame?.origin !== connection.origin
    )
      throw new Error(invalidSource());

    return { owner, connection };
  };
}
