/**
 * @file 管理桌面工作台中的项目网页和控制权。
 * @implementation 持有隔离的原生页面，校验工作台命令并执行受控网页操作。
 * @updated 2026-11-20T02:00+08:00
 */
import {
  BrowserWindow,
  ipcMain,
  WebContentsView,
  type Event,
  type Input,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MouseInputEvent,
  type WebContents,
} from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  desktopBrowserChannels,
  desktopBrowserCommandSchema,
  desktopBrowserLayoutSchema,
  desktopBrowserProjectIdSchema,
  desktopBrowserStateSchema,
  desktopBrowserUrlSchema,
  type DesktopBrowserCall,
  type DesktopBrowserLayout,
} from '../../shared/desktop-browser.js';

interface BrowserHost {
  getWindow(): BrowserWindow | undefined;
  getOrigin(): string | undefined;
  isStopping(): boolean;
}

export function createBrowserController(host: BrowserHost) {
  interface BrowserTab {
    id: string;
    projectId: string;
    owner: BrowserWindow;
    view: WebContentsView;
    busy: boolean;
    refs: Map<string, { id: number; editable: boolean }>;
    operation?: { id: string; abort: AbortController; done: Promise<void> };
    allowedOrigins?: string[];
    expectedKey?: (input: Input) => boolean;
    expectedMouse?: (input: MouseInputEvent) => boolean;
  }

  let visible: BrowserTab | undefined;
  let publishedLayout: DesktopBrowserLayout | undefined;
  let generation = 0;
  const selected = new Map<string, string>();
  const agentTarget = new Map<string, string>();
  const human = new Set<string>();
  const transferring = new Set<string>();
  const projectTabs = (projectId: string) =>
    [...tabs.values()].filter((tab) => tab.projectId === projectId);
  const current = (projectId: string) => tabs.get(selected.get(projectId) ?? '');
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

  function hostWindow(): BrowserWindow {
    const window = host.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || host.isStopping())
      throw new Error('工作台窗口不可用。');
    return window;
  }

  function ownsTab(tab: BrowserTab): boolean {
    const window = host.getWindow();
    if (
      !window ||
      window.isDestroyed() ||
      tab.owner !== window ||
      tabs.get(tab.id) !== tab ||
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
    const origin = host.getOrigin();
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
    const window = host.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || host.isStopping())
      return;
    if (tab && (!ownsTab(tab) || tab.projectId !== projectId)) return;
    const active = current(projectId);
    const contents = active?.view.webContents;
    const currentUrl = contents?.getURL() || '';
    const payload = desktopBrowserStateSchema.parse({
      projectId,
      tabs: projectTabs(projectId).map(({ id, view }) => ({
        id,
        title: view.webContents.getTitle(),
        url: view.webContents.getURL(),
      })),
      activeTabId: active?.id ?? null,
      agentTabId: agentTarget.get(projectId) ?? null,
      transferring: transferring.has(projectId),
      url: desktopBrowserUrlSchema.safeParse(currentUrl).success ? currentUrl : '',
      title: contents?.getTitle() || '',
      control: human.has(projectId),
      busy: projectTabs(projectId).some((entry) => entry.busy),
    });
    window.webContents.send(desktopBrowserChannels.state, payload);
  }

  function getTab(projectId: string, target: 'visible' | 'agent' = 'visible'): BrowserTab {
    const pinned = target === 'agent' ? tabs.get(agentTarget.get(projectId) ?? '') : undefined;
    const tab = pinned ?? current(projectId) ?? createTab(projectId);
    if (target === 'agent') agentTarget.set(projectId, tab.id);
    tabContents(tab);
    return tab;
  }

  function createTab(projectId: string): BrowserTab {
    desktopBrowserProjectIdSchema.parse(projectId);
    const owner = hostWindow();
    if (tabs.size >= 16 || projectTabs(projectId).length >= 8)
      throw new Error('浏览器标签已达上限，请关闭不再使用的标签。');
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
      id: randomUUID(),
      projectId,
      owner,
      view,
      busy: false,
      refs: new Map(),
    };
    tabs.set(tab.id, tab);
    if (!current(projectId)) selected.set(projectId, tab.id);
    const wc = view.webContents;
    contentsOwners.set(wc, tab);
    wc.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    wc.session.setPermissionCheckHandler(() => false);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-attach-webview', (event) => event.preventDefault());
    wc.on('before-input-event', (event, input) => {
      if (ownsTab(tab)) {
        if (human.has(projectId) && current(projectId) === tab) return;
        if (tab.expectedKey?.(input)) {
          tab.expectedKey = undefined;
          return;
        }
      }
      event.preventDefault();
    });
    wc.on('before-mouse-event', (event, input) => {
      if (ownsTab(tab)) {
        if (human.has(projectId) && current(projectId) === tab) return;
        if (tab.expectedMouse?.(input)) {
          tab.expectedMouse = undefined;
          return;
        }
      }
      event.preventDefault();
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
      removeTab(tab);
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
    publishedLayout = bounds
      ? { projectId, bounds }
      : publishedLayout?.projectId === projectId
        ? undefined
        : publishedLayout;
    if (!bounds) {
      if (visible?.projectId === projectId) hideVisible();
      return;
    }
    const tab = getTab(projectId);
    if (visible && visible !== tab) hideVisible();
    const [width, height] = owner.getContentSize();
    if (width === undefined || height === undefined) throw new Error('工作台窗口尺寸无效。');
    // Renderer rectangles use CSS pixels. Native views use the host's unzoomed coordinates.
    const zoom = owner.webContents.getZoomFactor();
    const x = Math.max(0, Math.round(bounds.x * zoom));
    const y = Math.max(0, Math.round(bounds.y * zoom));
    const w = Math.min(width, Math.round((bounds.x + bounds.width) * zoom)) - x;
    const h = Math.min(height, Math.round((bounds.y + bounds.height) * zoom)) - y;
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

  function removeTab(tab: BrowserTab): void {
    if (tabs.get(tab.id) !== tab) return;
    const { projectId } = tab;
    tabs.delete(tab.id);
    tab.operation?.abort.abort();
    if (visible === tab) hideVisible();
    if (agentTarget.get(projectId) === tab.id) agentTarget.delete(projectId);
    if (selected.get(projectId) === tab.id) {
      const replacement = projectTabs(projectId)[0];
      if (replacement) selected.set(projectId, replacement.id);
      else selected.delete(projectId);
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  function repaint(projectId: string): void {
    if (publishedLayout?.projectId === projectId) show(publishedLayout);
    state(projectId);
  }

  async function takeControl(projectId: string): Promise<void> {
    if (transferring.has(projectId)) throw new Error('正在交接浏览器控制权。');
    const origin = host.getOrigin();
    const active = getTab(projectId);
    transferring.add(projectId);
    state(projectId);
    try {
      for (const tab of projectTabs(projectId)) {
        const operation = tab.operation;
        if (!operation) continue;
        operation.abort.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            operation.done,
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                removeTab(tab);
                resolve();
              }, 1000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!origin || origin !== host.getOrigin()) throw new Error('工作台连接已更新。');
      human.add(projectId);
      getTab(projectId).view.webContents.focus();
      if (!ownsTab(active)) throw new Error('旧标签已隔离，先确认网页操作结果。');
    } finally {
      transferring.delete(projectId);
      repaint(projectId);
    }
  }

  function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const origin = host.getOrigin();
    const window = host.getWindow();
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      !origin ||
      host.isStopping()
    )
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
      state(projectId);
      return;
    }
    if (request.action === 'new-tab') {
      selected.set(projectId, createTab(projectId).id);
      repaint(projectId);
      return;
    }
    if (request.action === 'select-tab' || request.action === 'close-tab') {
      const selectedTab = tabs.get(request.tabId);
      if (!selectedTab || selectedTab.projectId !== projectId)
        throw new Error('该标签不属于当前项目。');
      if (request.action === 'select-tab') selected.set(projectId, selectedTab.id);
      else removeTab(selectedTab);
      repaint(projectId);
      return;
    }
    const tab = getTab(projectId);
    const wc = tabContents(tab);
    if (action === 'take') {
      await takeControl(projectId);
    } else if (action === 'release') {
      human.delete(projectId);
      agentTarget.set(projectId, tab.id);
      for (const item of projectTabs(projectId)) item.refs.clear();
      hostWindow().webContents.focus();
    } else if (request.action === 'navigate') {
      const destination = siteUrl(request.url);
      if (!human.has(projectId)) await takeControl(projectId);
      await tabContents(getTab(projectId)).loadURL(destination);
    } else {
      if (!human.has(projectId)) throw new Error('请先接管浏览器。');
      if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      if (action === 'forward' && wc.navigationHistory.canGoForward())
        wc.navigationHistory.goForward();
      if (action === 'reload') wc.reload();
    }
    state(projectId, tab);
  });

  async function runTool(request: DesktopBrowserCall) {
    const { projectId, allowedOrigins } = request;
    if (human.has(projectId) || transferring.has(projectId)) throw new Error('浏览器由用户控制。');
    const tab = getTab(projectId, 'agent');
    if (tab.busy) throw new Error('浏览器正在被接管或执行操作，请稍后重试。');
    tab.busy = true;
    tab.allowedOrigins = allowedOrigins;
    state(projectId, tab);
    const wc = tabContents(tab);
    const cdp = wc.debugger;
    const abort = new AbortController();
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    tab.operation = { id: request.id, abort, done };
    const stop = () => {
      if (!wc.isDestroyed()) wc.stop();
    };
    abort.signal.addEventListener('abort', stop, { once: true });
    const send = async (name: string, params?: object): Promise<unknown> => {
      abort.signal.throwIfAborted();
      const result: unknown = await cdp.sendCommand(name, params);
      abort.signal.throwIfAborted();
      return result;
    };
    try {
      if (request.name === 'browser_navigate') {
        const destination = siteUrl(request.args.url);
        if (allowedOrigins && !allowedOrigins.includes(new URL(destination).origin))
          throw new Error('站点未在项目的浏览器授权范围内。');
        await wc.loadURL(destination);
        abort.signal.throwIfAborted();
        tabContents(tab);
        return { text: `已打开 ${wc.getURL()}\n页面标题：${wc.getTitle()}` };
      }
      if (allowedOrigins && !allowedOrigins.includes(new URL(wc.getURL()).origin))
        throw new Error('当前页面未在项目的浏览器授权范围内。');
      if (!cdp.isAttached()) cdp.attach('1.3');
      if (request.name === 'browser_take_screenshot') {
        const detached = !tab.owner.contentView.children.includes(tab.view);
        if (detached) {
          tab.view.setBounds({ x: 0, y: 0, width: 960, height: 640 });
          tab.owner.contentView.addChildView(tab.view, 0);
        }
        try {
          const capture = await wc.capturePage(undefined, { stayHidden: false });
          abort.signal.throwIfAborted();
          tabContents(tab);
          return { png: capture.toPNG().toString('base64') };
        } finally {
          if (
            detached &&
            visible !== tab &&
            !tab.owner.isDestroyed() &&
            tab.owner.contentView.children.includes(tab.view)
          )
            tab.owner.contentView.removeChildView(tab.view);
        }
      }
      if (request.name === 'browser_snapshot') {
        const { nodes } = accessibilityTreeSchema.parse(await send('Accessibility.getFullAXTree'));
        tabContents(tab);
        tab.refs.clear();
        const revision = ++generation;
        const interactive = ['button', 'link', 'textbox', 'searchbox', 'checkbox', 'combobox'];
        const rows = nodes
          .filter(
            (node) =>
              !node.ignored &&
              (node.name?.value ||
                (node.backendDOMNodeId &&
                  ['textbox', 'searchbox'].includes(node.role?.value ?? ''))),
          )
          .sort(
            (a, b) =>
              Number(interactive.includes(b.role?.value ?? '')) -
              Number(interactive.includes(a.role?.value ?? '')),
          )
          .slice(0, 200)
          .map((node, index) => {
            const ref = `r${revision}-${index + 1}`;
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
      // Electron's before-input hooks also receive CDP events. Permit a single
      // matching event while the controller sends each approved input command.
      const sendKey = async (
        type: 'rawKeyDown' | 'keyDown' | 'keyUp',
        key: string,
        code: string,
        windowsVirtualKeyCode: number,
        modifiers = 0,
        text?: string,
      ) => {
        tab.expectedKey = (event) =>
          event.type === (type === 'keyUp' ? 'keyUp' : 'keyDown') &&
          event.key === key &&
          event.code === code &&
          event.control === (modifiers === 2);
        try {
          await send('Input.dispatchKeyEvent', {
            type,
            key,
            code,
            windowsVirtualKeyCode,
            modifiers,
            text,
          });
        } finally {
          tab.expectedKey = undefined;
        }
      };
      if (request.name === 'browser_type') {
        if (!target.editable) throw new Error('请输入有效的文本。');
        await send('DOM.focus', { backendNodeId: target.id });
        await sendKey('rawKeyDown', 'a', 'KeyA', 65, 2);
        await sendKey('keyUp', 'a', 'KeyA', 65, 2);
        await send('Input.insertText', { text: request.args.text });
        if (request.args.submit) {
          await sendKey('keyDown', 'Enter', 'Enter', 13, 0, '\r');
          await sendKey('keyUp', 'Enter', 'Enter', 13);
        }
      } else {
        await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.id });
        const { model } = boxModelSchema.parse(
          await send('DOM.getBoxModel', { backendNodeId: target.id }),
        );
        const [x1, y1, , , x3, y3] = model.content;
        const x = (x1 + x3) / 2;
        const y = (y1 + y3) / 2;
        const clicks = request.args.doubleClick ? 2 : 1;
        for (let clickCount = 1; clickCount <= clicks; clickCount++) {
          for (const type of ['mousePressed', 'mouseReleased'] as const) {
            tab.expectedMouse = (event) =>
              event.type === (type === 'mousePressed' ? 'mouseDown' : 'mouseUp') &&
              event.button === 'left' &&
              Math.abs(event.x - x) < 1 &&
              Math.abs(event.y - y) < 1;
            try {
              await send('Input.dispatchMouseEvent', {
                type,
                x,
                y,
                button: 'left',
                clickCount,
                buttons: type === 'mousePressed' ? 1 : 0,
              });
            } finally {
              tab.expectedMouse = undefined;
            }
          }
        }
      }
      tabContents(tab);
      tab.refs.clear();
      return { text: '网页操作已执行。请重新读取页面确认结果。' };
    } catch (error) {
      if (abort.signal.aborted)
        throw new Error('网页操作已取消。若此前已派发操作，请确认页面结果。');
      throw error;
    } finally {
      tab.operation = undefined;
      finish();
      tab.busy = false;
      tab.allowedOrigins = undefined;
      state(projectId, tab);
    }
  }

  function cancel(callId: string): void {
    for (const tab of tabs.values()) {
      if (tab.operation?.id === callId) tab.operation.abort.abort();
    }
  }

  function reset(): void {
    publishedLayout = undefined;
    hideVisible();
    for (const tab of tabs.values()) removeTab(tab);
    selected.clear();
    agentTarget.clear();
    human.clear();
    transferring.clear();
  }

  return { runTool, reset, cancel };
}
