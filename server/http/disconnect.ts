/**
 * @file 为可取消的 HTTP 请求绑定客户端断开信号。
 * @implementation 只吞掉断开后的错误，始终移除监听；已取消的请求也视为已处理。
 * @updated 2026-11-28T18:00:00+08:00
 */
import type { ServerResponse } from 'node:http';

export async function withClientDisconnect(
  res: ServerResponse,
  handle: (signal: AbortSignal) => Promise<true>,
): Promise<true> {
  const abort = new AbortController();
  const disconnect = () => abort.abort();
  res.once('close', disconnect);
  if (res.destroyed) disconnect();
  try {
    abort.signal.throwIfAborted();
    return await handle(abort.signal);
  } catch (error) {
    if (!abort.signal.aborted) throw error;
    return true;
  } finally {
    res.off('close', disconnect);
  }
}
