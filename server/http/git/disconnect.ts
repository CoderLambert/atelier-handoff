/**
 * @file 为可取消的 Git 请求绑定客户端断开信号。
 * @implementation 只吞掉断开后的错误，始终移除监听；已取消的请求也视为已处理。
 * @updated 2026-11-26T23:24:11+08:00
 */
import type { ServerResponse } from 'node:http';

export async function withGitDisconnect(
  res: ServerResponse,
  handle: (signal: AbortSignal) => Promise<true>,
): Promise<true> {
  const abort = new AbortController();
  const disconnect = () => abort.abort();
  res.once('close', disconnect);
  try {
    return await handle(abort.signal);
  } catch (error) {
    if (!abort.signal.aborted) throw error;
    return true;
  } finally {
    res.off('close', disconnect);
  }
}
