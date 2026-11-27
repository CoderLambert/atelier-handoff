/**
 * @file 校验工作台主进程 IPC 的发送来源并统一可信偏好通道绑定。
 * @implementation 提供可复用的主 frame 与连接稳定性校验，复用偏好读写模版并在退出或解绑时对称注销 IPC。
 * @updated 2026-11-27T22:00:00+08:00
 */
import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';

function isTrustedMainFrameSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  owner: BrowserWindow | undefined,
  origin: string | undefined,
  isStopping: () => boolean,
): owner is BrowserWindow {
  if (isStopping() || !owner || owner.isDestroyed() || !origin) return false;
  const contents = owner.webContents;
  if (contents.isDestroyed()) return false;
  return (
    event.sender === contents &&
    event.senderFrame !== null &&
    event.senderFrame === contents.mainFrame &&
    event.senderFrame.origin === origin
  );
}

export function createTrustedSenderPredicate(
  getWindow: () => BrowserWindow | undefined,
  getOrigin: () => string | undefined,
  isStopping: () => boolean,
): (event: IpcMainEvent | IpcMainInvokeEvent) => boolean {
  return (event) => isTrustedMainFrameSender(event, getWindow(), getOrigin(), isStopping);
}

export function createTrustedIpcGuard<Connection extends { origin: string }>(
  getWindow: () => BrowserWindow | undefined,
  getConnection: () => Connection | undefined,
  isStopping: () => boolean,
  invalidSource: () => string,
) {
  return function assertTrustedIpc(event: IpcMainInvokeEvent) {
    const owner = getWindow();
    const connection = getConnection();
    if (!connection || !isTrustedMainFrameSender(event, owner, connection.origin, isStopping)) {
      throw new Error(invalidSource());
    }
    return { owner, connection };
  };
}

export interface TrustedPreferenceIpcOptions<
  TGet,
  TSet,
  TResult,
  Connection extends { origin: string },
> {
  channels: { readonly get: string; readonly set: string };
  getSchema: z.ZodType<TGet>;
  setSchema: z.ZodType<TSet>;
  resultSchema: z.ZodType<TResult>;
  preferences: {
    get(): TResult;
    set(value: TSet, assertReady: () => void): Promise<TResult>;
  };
  getWindow: () => BrowserWindow | undefined;
  getConnection: () => Connection | undefined;
  isStopping: () => boolean;
  messages: {
    invalidSource: string;
    connectionChanged: string;
  };
  afterSet?: (result: TResult, owner: BrowserWindow) => void;
}

export function bindTrustedPreferenceIpc<
  TGet,
  TSet,
  TResult,
  Connection extends { origin: string },
>({
  channels,
  getSchema,
  setSchema,
  resultSchema,
  preferences,
  getWindow,
  getConnection,
  isStopping,
  messages,
  afterSet,
}: TrustedPreferenceIpcOptions<TGet, TSet, TResult, Connection>): {
  assertTrustedIpc: ReturnType<typeof createTrustedIpcGuard<Connection>>;
  unbind: () => void;
} {
  const assertTrustedIpc = createTrustedIpcGuard(
    getWindow,
    getConnection,
    isStopping,
    () => messages.invalidSource,
  );

  ipcMain.handle(channels.get, (event, input: unknown) => {
    assertTrustedIpc(event);
    getSchema.parse(input);
    return resultSchema.parse(preferences.get());
  });

  ipcMain.handle(channels.set, async (event, input: unknown) => {
    const { connection } = assertTrustedIpc(event);
    const parsed = setSchema.parse(input);
    const result = await preferences.set(parsed, () => {
      if (assertTrustedIpc(event).connection !== connection) {
        throw new Error(messages.connectionChanged);
      }
    });
    const { owner } = assertTrustedIpc(event);
    afterSet?.(result, owner);
    return resultSchema.parse(result);
  });

  return {
    assertTrustedIpc,
    unbind: () => {
      ipcMain.removeHandler(channels.get);
      ipcMain.removeHandler(channels.set);
    },
  };
}
