/**
 * @file 管理桌面应用生命周期和项目浏览器。
 * @implementation 启动后端与窗口，通过 IPC 和浏览器视图处理操作。
 * @updated 2026-11-20T02:00+08:00
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  WebContentsView,
  type Event,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import {
  desktopBrowserCallSchema,
  desktopBrowserChannels,
  desktopBrowserCommandSchema,
  desktopBrowserLayoutSchema,
  desktopBrowserProjectIdSchema,
  desktopBrowserProtocolVersion,
  desktopBrowserReadySchema,
  desktopBrowserResultSchema,
  desktopBrowserStateSchema,
  desktopBrowserUrlSchema,
  type DesktopBrowserCall,
  type DesktopBrowserLayout,
  type DesktopBrowserReady,
  type DesktopBrowserResult,
} from '../shared/desktop-browser.js';

const here = dirname(fileURLToPath(import.meta.url));
// The development bundle lives in dist/desktop; source execution lives in desktop.
const root = app.isPackaged
  ? join(process.resourcesPath, 'runtime')
  : fileURLToPath(new URL(import.meta.url.endsWith('.mts') ? '../' : '../../', import.meta.url));
const dataHome = process.env.XDG_DATA_HOME;
const packagedData = join(
  dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), '.local/share'),
  'atelier',
);
const dataDir = process.env.ATELIER_DATA_DIR
  ? requireAbsolutePath(process.env.ATELIER_DATA_DIR, 'ATELIER_DATA_DIR')
  : app.isPackaged
    ? packagedData
    : join(root, '.data');

interface BrowserTab {
  projectId: string;
  owner: BrowserWindow;
  view: WebContentsView;
  control: boolean;
  busy: boolean;
  refs: Map<string, { id: number; editable: boolean }>;
  generation: number;
  allowedOrigins?: string[];
}

let origin: string | undefined;
let window: BrowserWindow | undefined;
let backend: ChildProcess | undefined;
let visible: BrowserTab | undefined;
let stopping = false;
const tabs = new Map<string, BrowserTab>();
const contentsOwners = new WeakMap<WebContents, BrowserTab>();

const accessibilityTreeSchema = z.object({
  nodes: z.array(
    z.object({
      ignored: z.boolean().optional(),
      backendDOMNodeId: z.int().positive().optional(),
      name: z.object({ value: z.unknown() }).optional(),
      role: z.object({ value: z.string() }).optional(),
    }),
  ),
});
const coordinate = z.number().finite();
const boxModelSchema = z.object({
  model: z.object({
    content: z.tuple([
      coordinate,
      coordinate,
      coordinate,
      coordinate,
      coordinate,
      coordinate,
      coordinate,
      coordinate,
    ]),
  }),
});

function requireAbsolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return value;
}

function hostWindow(): BrowserWindow {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || stopping)
    throw new Error('工作台窗口不可用。');
  return window;
}

function ownsTab(tab: BrowserTab): boolean {
  if (
    !window ||
    window.isDestroyed() ||
    tab.owner !== window ||
    tabs.get(tab.projectId) !== tab ||
    tab.view.webContents.isDestroyed() ||
    contentsOwners.get(tab.view.webContents) !== tab
  )
    return false;
  const attachedOwner = BrowserWindow.fromWebContents(tab.view.webContents);
  return (
    (!attachedOwner || attachedOwner === tab.owner) &&
    (visible !== tab || tab.owner.contentView.children.includes(tab.view))
  );
}

function tabContents(tab: BrowserTab): WebContents {
  hostWindow();
  if (!ownsTab(tab)) throw new Error('浏览器视图不属于当前项目或窗口。');
  return tab.view.webContents;
}

function siteUrl(value: string): string {
  const url = new URL(desktopBrowserUrlSchema.parse(value));
  if (!origin) throw new Error('工作台服务尚未就绪。');
  if (
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    url.port === new URL(origin).port
  )
    throw new Error('原生浏览器不能打开工作台管理地址。');
  return url.href;
}

function state(projectId: string, tab?: BrowserTab): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || stopping) return;
  if (tab && (!ownsTab(tab) || tab.projectId !== projectId)) return;
  const contents = tab?.view.webContents;
  const currentUrl = contents?.getURL() || '';
  const payload = desktopBrowserStateSchema.parse({
    projectId,
    url: desktopBrowserUrlSchema.safeParse(currentUrl).success ? currentUrl : '',
    title: contents?.getTitle() || '',
    control: tab?.control ?? false,
    busy: tab?.busy ?? false,
  });
  window.webContents.send(desktopBrowserChannels.state, payload);
}

function getTab(projectId: string): BrowserTab {
  desktopBrowserProjectIdSchema.parse(projectId);
  const owner = hostWindow();
  const existing = tabs.get(projectId);
  if (existing) {
    tabContents(existing);
    return existing;
  }
  if (tabs.size >= 8) throw new Error('桌面浏览器最多可同时打开八个项目。');
  const partition = createHash('sha256').update(projectId).digest('hex').slice(0, 24);
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:atelier-browser-${partition}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const tab: BrowserTab = {
    projectId,
    owner,
    view,
    control: false,
    busy: false,
    refs: new Map(),
    generation: 0,
  };
  tabs.set(projectId, tab);
  const wc = view.webContents;
  contentsOwners.set(wc, tab);
  wc.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  wc.session.setPermissionCheckHandler(() => false);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.on('before-input-event', (event) => {
    if (!ownsTab(tab) || !tab.control) event.preventDefault();
  });
  wc.on('before-mouse-event', (event) => {
    if (!ownsTab(tab) || !tab.control) event.preventDefault();
  });
  const guard = (event: Event, url: string) => {
    try {
      if (!ownsTab(tab)) throw new Error('浏览器视图已失效。');
      const destination = siteUrl(url);
      if (
        tab.busy &&
        tab.allowedOrigins &&
        !tab.allowedOrigins.includes(new URL(destination).origin)
      )
        event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('did-start-navigation', () => tab.refs.clear());
  wc.on('did-navigate', () => state(projectId, tab));
  wc.on('did-navigate-in-page', () => state(projectId, tab));
  wc.on('page-title-updated', () => state(projectId, tab));
  wc.on('did-finish-load', () => state(projectId, tab));
  wc.on('destroyed', () => {
    contentsOwners.delete(wc);
    if (tabs.get(projectId) === tab) tabs.delete(projectId);
    if (visible === tab) hideVisible();
  });
  return tab;
}

function hideVisible(): void {
  if (!visible) return;
  const tab = visible;
  visible = undefined;
  if (!tab.owner.isDestroyed() && tab.owner.contentView.children.includes(tab.view))
    tab.owner.contentView.removeChildView(tab.view);
}

function show({ projectId, bounds }: DesktopBrowserLayout): void {
  const owner = hostWindow();
  if (!bounds) {
    if (visible?.projectId === projectId) hideVisible();
    return;
  }
  const tab = getTab(projectId);
  if (visible && visible !== tab) hideVisible();
  const [width, height] = owner.getContentSize();
  if (width === undefined || height === undefined) throw new Error('工作台窗口尺寸无效。');
  const x = Math.max(0, Math.round(bounds.x));
  const y = Math.max(0, Math.round(bounds.y));
  const w = Math.min(width - x, Math.round(bounds.width));
  const h = Math.min(height - y, Math.round(bounds.height));
  if (w < 1 || h < 1) {
    hideVisible();
    return;
  }
  if (!visible) {
    owner.contentView.addChildView(tab.view);
    visible = tab;
    state(projectId, tab);
  }
  tabContents(tab);
  tab.view.setBounds({ x, y, width: w, height: h });
}

function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || !origin || stopping)
    return false;
  const frame = event.senderFrame;
  return (
    event.sender === window.webContents &&
    frame !== null &&
    frame === window.webContents.mainFrame &&
    frame.origin === origin
  );
}

ipcMain.on(desktopBrowserChannels.layout, (event, value: unknown) => {
  if (!trusted(event)) return;
  const request = desktopBrowserLayoutSchema.safeParse(value);
  if (!request.success) return;
  try {
    show(request.data);
  } catch {
    state(request.data.projectId);
  }
});

ipcMain.handle(desktopBrowserChannels.command, async (event, value: unknown): Promise<void> => {
  if (!trusted(event)) throw new Error('浏览器控制来源无效。');
  const request = desktopBrowserCommandSchema.parse(value);
  const { projectId, action } = request;
  if (action === 'state') {
    state(projectId, tabs.get(projectId));
    return;
  }
  const tab = getTab(projectId);
  const wc = tabContents(tab);
  if (action === 'take') {
    if (tab.busy) throw new Error('浏览器正在执行操作，请稍后接管。');
    tab.control = true;
    tab.refs.clear();
    wc.focus();
  } else if (action === 'release') {
    tab.control = false;
    tab.refs.clear();
    hostWindow().webContents.focus();
  } else if (request.action === 'navigate') {
    if (tab.busy) throw new Error('浏览器正在执行操作。');
    const destination = siteUrl(request.url);
    tab.control = true;
    state(projectId, tab);
    await wc.loadURL(destination);
  } else {
    if (!tab.control) throw new Error('请先接管浏览器。');
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward())
      wc.navigationHistory.goForward();
    if (action === 'reload') wc.reload();
  }
  state(projectId, tab);
});

async function runTool(request: DesktopBrowserCall) {
  const { projectId, allowedOrigins } = request;
  const tab = getTab(projectId);
  if (tab.control || tab.busy) throw new Error('浏览器正在被接管或执行操作，请稍后重试。');
  tab.busy = true;
  tab.allowedOrigins = allowedOrigins;
  state(projectId, tab);
  const wc = tabContents(tab);
  const cdp = wc.debugger;
  try {
    if (request.name === 'browser_navigate') {
      const destination = siteUrl(request.args.url);
      if (allowedOrigins && !allowedOrigins.includes(new URL(destination).origin))
        throw new Error('站点未在项目的浏览器授权范围内。');
      await wc.loadURL(destination);
      tabContents(tab);
      return { text: `已打开 ${wc.getURL()}\n页面标题：${wc.getTitle()}` };
    }
    if (allowedOrigins && !allowedOrigins.includes(new URL(wc.getURL()).origin))
      throw new Error('当前页面未在项目的浏览器授权范围内。');
    if (request.name === 'browser_take_screenshot') {
      const capture = await wc.capturePage(undefined, { stayHidden: true });
      tabContents(tab);
      return { png: capture.toPNG().toString('base64') };
    }
    if (!cdp.isAttached()) cdp.attach('1.3');
    if (request.name === 'browser_snapshot') {
      const { nodes } = accessibilityTreeSchema.parse(
        await cdp.sendCommand('Accessibility.getFullAXTree'),
      );
      tabContents(tab);
      tab.refs.clear();
      tab.generation++;
      const interactive = ['button', 'link', 'textbox', 'searchbox', 'checkbox', 'combobox'];
      const rows = nodes
        .filter(
          (node) =>
            !node.ignored &&
            (node.name?.value ||
              (node.backendDOMNodeId && ['textbox', 'searchbox'].includes(node.role?.value ?? ''))),
        )
        .sort(
          (a, b) =>
            Number(interactive.includes(b.role?.value ?? '')) -
            Number(interactive.includes(a.role?.value ?? '')),
        )
        .slice(0, 200)
        .map((node, index) => {
          const ref = `r${tab.generation}-${index + 1}`;
          const role = node.role?.value || '';
          if (node.backendDOMNodeId)
            tab.refs.set(ref, {
              id: node.backendDOMNodeId,
              editable: ['textbox', 'searchbox'].includes(role),
            });
          return {
            ref: node.backendDOMNodeId ? ref : undefined,
            role,
            name: String(node.name?.value ?? '').slice(0, 300),
          };
        });
      return { text: JSON.stringify({ url: wc.getURL(), title: wc.getTitle(), elements: rows }) };
    }
    const target = tab.refs.get(request.args.target ?? request.args.ref ?? '');
    if (!target) throw new Error('该页面引用已失效，请重新读取页面。');
    if (request.name === 'browser_type') {
      if (!target.editable) throw new Error('请输入有效的文本。');
      await cdp.sendCommand('DOM.focus', { backendNodeId: target.id });
      await cdp.sendCommand('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      await cdp.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      await cdp.sendCommand('Input.insertText', { text: request.args.text });
      if (request.args.submit) {
        await cdp.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          text: '\r',
        });
        await cdp.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
        });
      }
    } else {
      await cdp.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.id });
      const { model } = boxModelSchema.parse(
        await cdp.sendCommand('DOM.getBoxModel', { backendNodeId: target.id }),
      );
      const [x1, y1, , , x3, y3] = model.content;
      const point = {
        x: (x1 + x3) / 2,
        y: (y1 + y3) / 2,
        button: 'left',
        clickCount: request.args.doubleClick ? 2 : 1,
      };
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
    }
    tabContents(tab);
    tab.refs.clear();
    return { text: '网页操作已执行。请重新读取页面确认结果。' };
  } finally {
    tab.busy = false;
    tab.allowedOrigins = undefined;
    state(projectId, tab);
  }
}

function waitForReady(child: ChildProcess): Promise<DesktopBrowserReady> {
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('disconnect', onDisconnect);
    };
    const onError = (error: Error) => {
      clean();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      onError(new Error(`工作台服务已退出 (${signal ?? code})。`));
    const onDisconnect = () => onError(new Error('工作台服务连接已断开。'));
    const onMessage = (value: unknown) => {
      const ready = desktopBrowserReadySchema.safeParse(value);
      if (!ready.success) {
        onError(new Error('工作台服务就绪响应无效。'));
        return;
      }
      clean();
      resolve(ready.data);
    };
    const timeout = setTimeout(() => onError(new Error('工作台服务启动超时。')), 12_000);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('disconnect', onDisconnect);
  });
}

async function handleBrowserCall(child: ChildProcess, value: unknown): Promise<void> {
  if (child !== backend || stopping) return;
  const request = desktopBrowserCallSchema.safeParse(value);
  if (!request.success) return;
  let result: DesktopBrowserResult;
  const header = {
    type: 'desktop-browser-result',
    protocolVersion: desktopBrowserProtocolVersion,
    id: request.data.id,
  } as const;
  try {
    result = desktopBrowserResultSchema.parse({ ...header, ...(await runTool(request.data)) });
  } catch (error) {
    result = desktopBrowserResultSchema.parse({
      ...header,
      error: error instanceof Error ? error.message : '浏览器操作失败。',
    });
  }
  if (child === backend && child.connected && !stopping)
    child.send(result, (error) => {
      if (error && !stopping) console.error('浏览器响应发送失败。');
    });
}

async function start(): Promise<void> {
  if (stopping) return;
  const packaged = app.isPackaged;
  const nodeBin = join(root, 'bin');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATELIER_DESKTOP_BROWSER: '1',
  };
  if (packaged) {
    env.ATELIER_DATA_DIR = dataDir;
    env.ATELIER_PORT ??= '0';
    env.PATH = [nodeBin, process.env.PATH].filter(Boolean).join(delimiter);
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
  }
  const child = fork(join(root, packaged ? 'server/main.js' : 'server/main.ts'), [], {
    cwd: root,
    execPath: packaged ? join(nodeBin, 'node') : process.env.npm_node_execpath || 'node',
    execArgv: packaged ? [] : ['--env-file-if-exists=.env', '--import', 'tsx'],
    env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  backend = child;
  child.on('error', (error: Error) => {
    if (!stopping) console.error(error.message);
  });
  const ready = await waitForReady(child);
  if (stopping || !child.connected || child.exitCode !== null || child.signalCode !== null)
    throw new Error('工作台服务已断开。');
  origin = `http://127.0.0.1:${ready.port}`;
  child.on('message', (value: unknown) => {
    void handleBrowserCall(child, value).catch((error: unknown) => {
      if (!stopping) console.error(error instanceof Error ? error.message : '浏览器操作失败。');
    });
  });
  const owner = new BrowserWindow({
    width: 1440,
    height: 960,
    title: 'atelier',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window = owner;
  owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  owner.webContents.on('will-attach-webview', (event) => event.preventDefault());
  owner.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  await owner.loadURL(origin);
}

app.setName('atelier');
// Set the profile before taking the lock: packaged and development instances must
// not share Chromium partitions, and disposable smoke profiles must stay isolated.
const requestedProfile = app.commandLine.getSwitchValue('user-data-dir');
if (requestedProfile || app.isPackaged || process.env.ATELIER_DATA_DIR) {
  const profile = requestedProfile
    ? requireAbsolutePath(requestedProfile, '--user-data-dir')
    : join(dataDir, 'desktop-profile');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : '工作台启动失败。');
      app.quit();
    });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (stopping) return;
  stopping = true;
  hideVisible();
  for (const tab of tabs.values())
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  const child = backend;
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    event.preventDefault();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 7_000);
    timeout.unref();
    child.once('exit', () => {
      clearTimeout(timeout);
      app.quit();
    });
    child.kill('SIGTERM');
  }
});
