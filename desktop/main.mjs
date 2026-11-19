import { app, BrowserWindow, ipcMain, WebContentsView } from 'electron';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const origin = `http://127.0.0.1:${process.env.ATELIER_PORT || '4317'}`;
let window;
let backend;
let visible;
let stopping = false;
const tabs = new Map();
const validProject = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);

function siteUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('请输入 HTTP 或 HTTPS 网页地址。');
  if (
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    url.port === new URL(origin).port
  )
    throw new Error('原生浏览器不能打开工作台管理地址。');
  return url.href;
}

function state(projectId, tab) {
  if (!window || window.isDestroyed()) return;
  const contents = tab?.view.webContents;
  window.webContents.send('browser:state', {
    projectId,
    url: contents?.getURL() || '',
    title: contents?.getTitle() || '',
    control: tab?.control ?? false,
    busy: Boolean(tab?.busy),
  });
}

function getTab(projectId) {
  if (!validProject(projectId)) throw new Error('无效项目。');
  if (tabs.has(projectId)) return tabs.get(projectId);
  if (tabs.size >= 8) throw new Error('桌面浏览器最多可同时打开八个项目。');
  const partition = createHash('sha256').update(projectId).digest('hex').slice(0, 24);
  const view = new WebContentsView({
    webPreferences: {
      partition: `persist:atelier-browser-${partition}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const tab = { view, control: false, busy: false, refs: new Map(), generation: 0 };
  tabs.set(projectId, tab);
  const wc = view.webContents;
  wc.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  wc.session.setPermissionCheckHandler(() => false);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('before-input-event', (event) => {
    if (!tab.control) event.preventDefault();
  });
  wc.on('before-mouse-event', (event) => {
    if (!tab.control) event.preventDefault();
  });
  const guard = (event, url) => {
    try {
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
  for (const event of [
    'did-navigate',
    'did-navigate-in-page',
    'page-title-updated',
    'did-finish-load',
  ])
    wc.on(event, () => state(projectId, tab));
  wc.on('destroyed', () => tabs.delete(projectId));
  return tab;
}

function show(projectId, bounds) {
  if (visible && (!bounds || visible.projectId !== projectId)) {
    window.contentView.removeChildView(visible.view);
    visible = undefined;
  }
  if (!bounds) return;
  const tab = getTab(projectId);
  const [width, height] = window.getContentSize();
  const x = Math.max(0, Math.round(bounds.x));
  const y = Math.max(0, Math.round(bounds.y));
  const w = Math.min(width - x, Math.round(bounds.width));
  const h = Math.min(height - y, Math.round(bounds.height));
  if (w < 1 || h < 1) return;
  if (!visible) {
    window.contentView.addChildView(tab.view);
    visible = { projectId, view: tab.view };
    state(projectId, tab);
  }
  tab.view.setBounds({ x, y, width: w, height: h });
}

function trusted(event) {
  return (
    event.sender === window?.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    new URL(event.senderFrame.url).origin === origin
  );
}

ipcMain.on('browser:layout', (event, { projectId, bounds }) => {
  if (!trusted(event) || !validProject(projectId)) return;
  if (bounds && !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))) return;
  try {
    show(projectId, bounds);
  } catch {
    state(projectId);
  }
});

ipcMain.handle('browser:command', async (event, { projectId, action, url }) => {
  if (!trusted(event)) throw new Error('浏览器控制来源无效。');
  if (action === 'state') {
    state(projectId, tabs.get(projectId));
    return;
  }
  const tab = getTab(projectId);
  const wc = tab.view.webContents;
  if (action === 'take') {
    if (tab.busy) throw new Error('浏览器正在执行操作，请稍后接管。');
    tab.control = true;
    wc.focus();
  } else if (action === 'release') {
    tab.control = false;
    tab.refs.clear();
    window.webContents.focus();
  } else if (action === 'navigate') {
    if (tab.busy) throw new Error('浏览器正在执行操作。');
    const destination = siteUrl(url);
    tab.control = true;
    state(projectId, tab);
    await wc.loadURL(destination);
  } else if (action === 'back' || action === 'forward' || action === 'reload') {
    if (!tab.control) throw new Error('请先接管浏览器。');
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward())
      wc.navigationHistory.goForward();
    if (action === 'reload') wc.reload();
  } else if (action !== 'state') throw new Error('未知浏览器操作。');
  state(projectId, tab);
});

async function runTool(projectId, name, args, allowedOrigins) {
  const tab = getTab(projectId);
  if (tab.control || tab.busy) throw new Error('浏览器正在被接管或执行操作，请稍后重试。');
  tab.busy = true;
  tab.allowedOrigins = allowedOrigins;
  state(projectId, tab);
  const wc = tab.view.webContents;
  const cdp = wc.debugger;
  try {
    if (name === 'browser_navigate') {
      const destination = siteUrl(args.url);
      if (allowedOrigins && !allowedOrigins.includes(new URL(destination).origin))
        throw new Error('站点未在项目的浏览器授权范围内。');
      await wc.loadURL(destination);
      return { text: `已打开 ${wc.getURL()}\n页面标题：${wc.getTitle()}` };
    }
    if (allowedOrigins && !allowedOrigins.includes(new URL(wc.getURL()).origin))
      throw new Error('当前页面未在项目的浏览器授权范围内。');
    if (name === 'browser_take_screenshot') {
      if (args.fullPage || args.target) throw new Error('桌面版截图支持当前可见网页区域。');
      return {
        png: (await wc.capturePage(undefined, { stayHidden: true })).toPNG().toString('base64'),
      };
    }
    if (!cdp.isAttached()) cdp.attach('1.3');
    if (name === 'browser_snapshot') {
      const { nodes } = await cdp.sendCommand('Accessibility.getFullAXTree');
      tab.refs.clear();
      tab.generation++;
      const rows = nodes
        .filter(
          (node) =>
            !node.ignored &&
            (node.name?.value ||
              (node.backendDOMNodeId && ['textbox', 'searchbox'].includes(node.role?.value))),
        )
        .sort(
          (a, b) =>
            Number(
              ['button', 'link', 'textbox', 'searchbox', 'checkbox', 'combobox'].includes(
                b.role?.value,
              ),
            ) -
            Number(
              ['button', 'link', 'textbox', 'searchbox', 'checkbox', 'combobox'].includes(
                a.role?.value,
              ),
            ),
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
    const target = tab.refs.get(args.target ?? args.ref);
    if (!target) throw new Error('该页面引用已失效，请重新读取页面。');
    if (name === 'browser_type') {
      if (!target.editable || typeof args.text !== 'string' || args.text.length > 4000)
        throw new Error('请输入有效的文本。');
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
      await cdp.sendCommand('Input.insertText', { text: args.text });
      if (args.submit) {
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
    } else if (name === 'browser_click') {
      await cdp.sendCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.id });
      const { model } = await cdp.sendCommand('DOM.getBoxModel', { backendNodeId: target.id });
      const q = model.content;
      const point = {
        x: (q[0] + q[4]) / 2,
        y: (q[1] + q[5]) / 2,
        button: 'left',
        clickCount: args.doubleClick ? 2 : 1,
      };
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
      await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
    } else throw new Error('桌面浏览器不支持此工具。');
    tab.refs.clear();
    return { text: '网页操作已执行。请重新读取页面确认结果。' };
  } finally {
    tab.busy = false;
    state(projectId, tab);
  }
}

async function start() {
  backend = fork(join(root, 'server/main.ts'), [], {
    cwd: root,
    execPath: process.env.npm_node_execpath || 'node',
    execArgv: ['--env-file-if-exists=.env', '--import', 'tsx'],
    env: { ...process.env, ATELIER_DESKTOP_BROWSER: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  backend.on('message', async (message) => {
    if (message?.type !== 'desktop-browser-call') return;
    let result;
    try {
      result = await runTool(message.projectId, message.name, message.args, message.allowedOrigins);
    } catch (error) {
      result = { error: error instanceof Error ? error.message : '浏览器操作失败。' };
    }
    if (backend.connected)
      backend.send({ type: 'desktop-browser-result', id: message.id, ...result });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('工作台服务启动超时。')), 12000);
    backend.once('error', reject);
    backend.once('exit', (code) => reject(new Error(`工作台服务已退出 (${code})。`)));
    backend.once('message', (message) => {
      clearTimeout(timeout);
      if (message?.type === 'desktop-browser-ready') resolve();
      else reject(new Error('工作台服务启动失败。'));
    });
  });
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    title: 'atelier',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  await window.loadURL(origin);
}

app.setName('atelier');
if (!app.requestSingleInstanceLock()) app.quit();
else
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      console.error(error.message);
      app.quit();
    });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (stopping) return;
  stopping = true;
  for (const tab of tabs.values())
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  if (backend?.exitCode === null) {
    event.preventDefault();
    backend.once('exit', () => app.quit());
    backend.kill('SIGTERM');
    const timeout = setTimeout(() => backend.kill('SIGKILL'), 7000);
    timeout.unref();
  }
});
