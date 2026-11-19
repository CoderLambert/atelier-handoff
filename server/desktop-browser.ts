/**
 * @file 将服务端浏览器操作转发给桌面进程。
 * @implementation 校验 IPC 消息，关联请求结果并处理取消、超时和断连。
 * @updated 2026-11-20T02:00+08:00
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../shared/types.js';
import {
  desktopBrowserCallSchema,
  desktopBrowserProtocolVersion,
  desktopBrowserResultIdentitySchema,
  desktopBrowserResultSchema,
  type DesktopBrowserResult,
} from '../shared/desktop-browser.js';

interface PendingCall {
  resolve(result: DesktopBrowserResult): void;
  reject(error: AppError): void;
}
const pending = new Map<string, PendingCall>();

export function desktopBrowserEnabled(): boolean {
  return (
    process.env.ATELIER_DESKTOP_BROWSER === '1' &&
    typeof process.send === 'function' &&
    process.connected
  );
}

if (desktopBrowserEnabled()) {
  process.on('message', (value: unknown) => {
    const result = desktopBrowserResultSchema.safeParse(value);
    if (result.success) pending.get(result.data.id)?.resolve(result.data);
    else {
      const identity = desktopBrowserResultIdentitySchema.safeParse(value);
      if (identity.success)
        pending
          .get(identity.data.id)
          ?.reject(new AppError('DESKTOP_BROWSER_FAILED', '桌面浏览器返回了无效响应。', 502));
    }
  });
  process.once('disconnect', () => {
    for (const call of pending.values())
      call.reject(new AppError('DESKTOP_BROWSER_FAILED', '桌面浏览器连接已断开。', 502));
  });
}

export async function callDesktopBrowser(
  projectId: string,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  allowedOrigins?: string[],
): Promise<DesktopBrowserResult> {
  if (!desktopBrowserEnabled())
    throw new AppError('DESKTOP_BROWSER_FAILED', '桌面浏览器连接不可用。', 502);
  const parsed = desktopBrowserCallSchema.safeParse({
    type: 'desktop-browser-call',
    protocolVersion: desktopBrowserProtocolVersion,
    id: randomUUID(),
    projectId,
    name,
    args,
    allowedOrigins,
  });
  if (!parsed.success)
    throw new AppError('DESKTOP_BROWSER_INVALID_INPUT', '桌面浏览器操作参数无效。', 400);
  const request = parsed.data;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  deadline.throwIfAborted();
  return new Promise<DesktopBrowserResult>((resolve, reject) => {
    const clean = () => {
      pending.delete(request.id);
      deadline.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      clean();
      reject(error);
    };
    const abort = () => fail(deadline.reason);
    pending.set(request.id, {
      resolve(result) {
        clean();
        if (result.error !== undefined)
          reject(new AppError('DESKTOP_BROWSER_FAILED', result.error, 409));
        else resolve(result);
      },
      reject: fail,
    });
    deadline.addEventListener('abort', abort, { once: true });
    if (deadline.aborted) {
      abort();
      return;
    }
    try {
      const send = process.send;
      if (!send || !process.connected) {
        fail(new AppError('DESKTOP_BROWSER_FAILED', '桌面浏览器连接已断开。', 502));
        return;
      }
      send.call(process, request, (error: Error | null) => {
        if (error) fail(new AppError('DESKTOP_BROWSER_FAILED', '桌面浏览器连接已断开。', 502));
      });
    } catch {
      fail(new AppError('DESKTOP_BROWSER_FAILED', '桌面浏览器连接已断开。', 502));
    }
  });
}
