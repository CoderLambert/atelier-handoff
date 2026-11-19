import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface BrowserFrame {
  title: string;
  url: string;
  jpeg?: string;
}

export async function launchPreviewBrowser(signal: AbortSignal) {
  signal.throwIfAborted();
  const profile = await mkdtemp(join(tmpdir(), 'atelier-browser-'));
  const child = spawn(
    '/usr/bin/chromium',
    [
      '--headless',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let exited = false;
  const finished = new Promise<void>((resolve) => {
    child.once('close', () => {
      exited = true;
      resolve();
    });
    child.once('error', () => {
      exited = true;
      resolve();
    });
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (!exited) child.kill();
      const timeout = setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, 1500);
      try {
        await finished;
      } finally {
        clearTimeout(timeout);
      }
      await rm(profile, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
    })());

  try {
    const startup = AbortSignal.any([signal, AbortSignal.timeout(5500)]);
    let port = '';
    while (!port && !exited) {
      startup.throwIfAborted();
      const contents = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      port = /^(\d{1,5})\n/.exec(contents)?.[1] ?? '';
      if (!port) await delay(70, undefined, { signal: startup });
    }
    if (!port) throw new Error('Chromium preview could not start');
    return { endpoint: `http://127.0.0.1:${port}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

interface Target {
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

export async function readBrowserFrame(
  endpoint: string,
  includeImage: boolean,
  preferredUrl?: string,
): Promise<BrowserFrame | null> {
  const response = await fetch(`${endpoint}/json/list`, {
    redirect: 'error',
    signal: AbortSignal.timeout(1200),
  });
  if (!response.ok) return null;
  const pages = (await response.json()) as Target[];
  const tabs = pages.filter((target) => target.type === 'page' && /^https?:\/\//.test(target.url));
  const page = tabs.find(({ url }) => url === preferredUrl) ?? tabs[0];
  if (!page) return null;
  const frame: BrowserFrame = { title: page.title.slice(0, 200), url: page.url.slice(0, 2048) };
  if (!includeImage) return frame;
  const ws = new URL(page.webSocketDebuggerUrl);
  if (ws.origin !== endpoint.replace(/^http:/, 'ws:') || !ws.pathname.startsWith('/devtools/page/'))
    return frame;
  const socket = new WebSocket(ws);
  return new Promise<BrowserFrame>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      socket.close();
      resolve(frame);
    };
    const timeout = setTimeout(finish, 1800);
    socket.addEventListener('error', finish, { once: true });
    socket.addEventListener('close', finish, { once: true });
    socket.addEventListener(
      'open',
      () => {
        socket.send(
          JSON.stringify({
            id: 1,
            method: 'Page.captureScreenshot',
            params: { format: 'jpeg', quality: 65 },
          }),
        );
      },
      { once: true },
    );
    socket.addEventListener('message', ({ data }) => {
      try {
        const reply = JSON.parse(String(data));
        if (reply.id !== 1) return;
        if (typeof reply.result?.data === 'string' && reply.result.data.length <= 2_000_000)
          frame.jpeg = reply.result.data;
      } catch {
        frame.jpeg = undefined;
      } finally {
        finish();
      }
    });
  });
}
