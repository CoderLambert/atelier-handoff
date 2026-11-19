import { randomUUID } from 'node:crypto';
import { AppError } from '../shared/types.js';

interface BrowserResult {
  type: 'desktop-browser-result';
  id: string;
  text?: string;
  png?: string;
  error?: string;
}

const pending = new Map<string, (result: BrowserResult) => void>();

export function desktopBrowserEnabled() {
  return process.env.ATELIER_DESKTOP_BROWSER === '1' && typeof process.send === 'function';
}

if (desktopBrowserEnabled()) {
  process.on('message', (value: unknown) => {
    const result = value as Partial<BrowserResult>;
    if (result?.type === 'desktop-browser-result' && typeof result.id === 'string') {
      pending.get(result.id)?.(result as BrowserResult);
    }
  });
}

export async function callDesktopBrowser(
  projectId: string,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  allowedOrigins?: string[],
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  deadline.throwIfAborted();
  const id = randomUUID();
  return new Promise<BrowserResult>((resolve, reject) => {
    const clean = () => {
      pending.delete(id);
      deadline.removeEventListener('abort', abort);
    };
    const abort = () => {
      clean();
      reject(deadline.reason);
    };
    pending.set(id, (result) => {
      clean();
      if (result.error) reject(new AppError('DESKTOP_BROWSER_FAILED', result.error, 409));
      else resolve(result);
    });
    deadline.addEventListener('abort', abort, { once: true });
    process.send!(
      { type: 'desktop-browser-call', id, projectId, name, args, allowedOrigins },
      (error: Error | null) => {
        if (error) {
          clean();
          reject(new AppError('DESKTOP_BROWSER_FAILED', '桌面浏览器连接已断开。', 502));
        }
      },
    );
  });
}
