/**
 * @file 将运行时浏览器操作转发给桌面进程并管理请求生命周期。
 * @implementation 按请求标识关联 IPC 响应，在桌面操作时限外预留恢复时间，并处理取消、超时和断连。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.js';
import {
  desktopBrowserCallSchema,
  desktopBrowserCancelSchema,
  desktopBrowserIpcGraceMs,
  desktopBrowserProtocolVersion,
  desktopBrowserResultIdentitySchema,
  desktopBrowserResultSchema,
  desktopBrowserTimeoutMs,
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
  runId: string,
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
    runId,
    name,
    args,
    allowedOrigins,
  });
  if (!parsed.success)
    throw new AppError('DESKTOP_BROWSER_INVALID_INPUT', '桌面浏览器操作参数无效。', 400);
  const request = parsed.data;
  // Give main time to finish recovery and return its more specific result.
  const ipcTimeout = AbortSignal.timeout(
    desktopBrowserTimeoutMs(request.name) + desktopBrowserIpcGraceMs,
  );
  const deadline = AbortSignal.any([signal, ipcTimeout]);
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
    const abort = () => {
      if (process.connected && process.send) {
        const message = desktopBrowserCancelSchema.parse({
          type: 'desktop-browser-cancel',
          protocolVersion: desktopBrowserProtocolVersion,
          id: request.id,
        });
        process.send(message, () => {});
      }
      if (deadline.reason === ipcTimeout.reason) {
        const input = request.name === 'browser_click' || request.name === 'browser_type';
        fail(
          new AppError(
            'DESKTOP_BROWSER_TIMEOUT',
            '桌面浏览器未返回结果，已请求取消。请确认浏览器状态。' +
              (input ? '网站可能已收到操作。请先核对结果，勿直接重试。' : ''),
            504,
          ),
        );
      } else fail(deadline.reason);
    };
    pending.set(request.id, {
      resolve(result) {
        clean();
        if (result.error !== undefined)
          reject(
            new AppError(
              result.errorCode ?? 'DESKTOP_BROWSER_FAILED',
              result.error,
              result.errorCode === 'DESKTOP_BROWSER_TIMEOUT' ? 504 : result.errorCode ? 502 : 409,
            ),
          );
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
