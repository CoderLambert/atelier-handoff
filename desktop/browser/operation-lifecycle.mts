/**
 * @file 管理原生浏览器工具执行的超时、取消与崩溃标签恢复生命周期。
 * @implementation 隔离只读取消与交互操作 1 秒宽限期替身逻辑，确保状态标志、定时器和操作完成句柄在任意退出路径上对称释放。
 * @updated 2026-11-27T22:00:00+08:00
 */
import { AppError } from '../../shared/errors.js';

export const BROWSER_STOP_GRACE_MS = 1_000;

export function createRendererGoneError(): AppError {
  return new AppError('DESKTOP_BROWSER_RENDERER_GONE', '网页进程已退出，已替换受影响的标签。', 502);
}

export interface BrowserOperationHandle {
  readonly id: string;
  readonly abort: AbortController;
  readonly done: Promise<void>;
  readonly retire: (error?: Error) => void;
}

export interface BrowserOperationContext {
  readonly signal: AbortSignal;
  waitForNative<T>(pending: Promise<T>): Promise<T>;
  markInputDispatched(): void;
}

export interface BrowserOperationOptions<T> {
  readonly id: string;
  readonly timeoutMs: number;
  readonly readOnly: boolean;
  readonly isNavigate?: boolean;
  readonly stopGraceMs?: number;
  attachHandle(handle: BrowserOperationHandle): void;
  isCurrentOperation(): boolean;
  canAct(): boolean;
  isRendererCrashed(): boolean;
  onAbortCleanup(): void;
  onStopReadOnly?(): void;
  onStopNavigate?(): void;
  onReplaceStuckTab(): void;
  onRendererCrashed(error: AppError): void;
  onBeforeRun(): void;
  onFinally(): void;
  execute(context: BrowserOperationContext): Promise<T>;
}

export async function runBrowserOperation<T>(options: BrowserOperationOptions<T>): Promise<T> {
  const {
    id,
    timeoutMs,
    readOnly,
    isNavigate = false,
    stopGraceMs = BROWSER_STOP_GRACE_MS,
    attachHandle,
    isCurrentOperation,
    canAct,
    isRendererCrashed,
    onAbortCleanup,
    onStopReadOnly,
    onStopNavigate,
    onReplaceStuckTab,
    onRendererCrashed,
    onBeforeRun,
    onFinally,
    execute,
  } = options;

  const abort = new AbortController();
  let finish = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  let settled = false;
  let viewFailure: Error | undefined;
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const retire = (error?: Error) => {
    if (settled) return;
    if (error !== undefined) viewFailure = error;
    release();
  };

  const waitForNative = <V,>(pending: Promise<V>): Promise<V> =>
    Promise.race([
      pending,
      released.then(() => {
        throw viewFailure ?? new Error('已结束对网页操作的等待。');
      }),
    ]);

  const timeoutReason = new Error('Browser tool deadline exceeded');
  let inputDispatched = false;
  let replaced = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

  attachHandle({ id, abort, done, retire });

  const stop = () => {
    onAbortCleanup();
    if (!canAct()) return;
    if (readOnly) {
      // Reads can be abandoned without reloading the page or stopping its navigation.
      release();
      onStopReadOnly?.();
      return;
    }
    cleanupTimer = setTimeout(() => {
      if (!isCurrentOperation() || !canAct()) return;
      replaced = true;
      onReplaceStuckTab();
    }, stopGraceMs);
    if (isNavigate) onStopNavigate?.();
  };

  abort.signal.addEventListener('abort', stop, { once: true });
  const deadline = setTimeout(() => abort.abort(timeoutReason), timeoutMs);

  try {
    onBeforeRun();
    return await execute({
      signal: abort.signal,
      waitForNative,
      markInputDispatched: () => {
        inputDispatched = true;
      },
    });
  } catch (error) {
    if (isRendererCrashed()) onRendererCrashed(createRendererGoneError());
    const verifyInput = inputDispatched ? '网站可能已收到操作。请先核对结果，勿直接重试。' : '';
    if (viewFailure instanceof AppError) {
      throw new AppError(viewFailure.code, viewFailure.message + verifyInput, viewFailure.status);
    }
    const recovery = replaced ? '旧标签未响应，已换成空白标签。请重新打开网页。' : '原标签已保留。';
    if (abort.signal.reason === timeoutReason) {
      throw new AppError(
        'DESKTOP_BROWSER_TIMEOUT',
        `网页操作在 ${timeoutMs / 1000} 秒内未完成。${recovery}${verifyInput}`,
        504,
      );
    }
    if (abort.signal.aborted) throw new Error(`网页操作已取消。${verifyInput}`);
    if (verifyInput && error instanceof Error) throw new Error(error.message + verifyInput);
    throw error;
  } finally {
    settled = true;
    clearTimeout(deadline);
    clearTimeout(cleanupTimer);
    abort.signal.removeEventListener('abort', stop);
    onFinally();
    finish();
  }
}
