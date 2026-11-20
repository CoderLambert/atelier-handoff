/**
 * @file 向渲染进程提供桌面浏览器和原生文件桥接接口。
 * @implementation 使用共享 schema 校验请求和响应，经 Electron IPC 转发浏览器及文件操作，并管理浏览器状态订阅。
 * @updated 2026-11-20T03:34:05+08:00
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  desktopBrowserChannels,
  desktopBrowserCommandSchema,
  desktopBrowserLayoutSchema,
  desktopBrowserStateSchema,
  type DesktopBrowserBridge,
} from '../shared/desktop-browser.js';

const bridge: DesktopBrowserBridge = {
  layout(projectId, bounds) {
    const request = desktopBrowserLayoutSchema.parse({ projectId, bounds });
    ipcRenderer.send(desktopBrowserChannels.layout, request);
  },
  async command(projectId, action, value) {
    const request = desktopBrowserCommandSchema.parse({
      projectId,
      action,
      ...(action === 'select-tab' || action === 'close-tab'
        ? { tabId: value }
        : action === 'cancel-download' || action === 'reveal-download'
          ? { downloadId: value }
          : action === 'navigate' || action === 'open-tab' || action === 'open-external'
            ? { url: value }
            : {}),
    });
    const response: unknown = await ipcRenderer.invoke(desktopBrowserChannels.command, request);
    if (response !== undefined) throw new Error('浏览器返回了无效响应。');
  },
  subscribe(callback) {
    if (typeof callback !== 'function') throw new TypeError('浏览器状态订阅需要回调函数。');
    const listener = (_event: IpcRendererEvent, value: unknown) => {
      const state = desktopBrowserStateSchema.safeParse(value);
      if (state.success) callback(state.data);
    };
    ipcRenderer.on(desktopBrowserChannels.state, listener);
    return () => {
      ipcRenderer.removeListener(desktopBrowserChannels.state, listener);
    };
  },
};

contextBridge.exposeInMainWorld('atelierDesktop', bridge);

import {
  desktopArtifactIdSchema,
  desktopArtifactSaveSchema,
  desktopDirectoryResultSchema,
  desktopFileActionResultSchema,
  desktopFilesChannels,
  type DesktopFilesBridge,
} from '../shared/desktop-files.js';

const files: DesktopFilesBridge = {
  async exportDiagnostics() {
    return desktopFileActionResultSchema.parse(
      await ipcRenderer.invoke(desktopFilesChannels.exportDiagnostics),
    );
  },
  async pickDirectory() {
    return desktopDirectoryResultSchema.parse(
      await ipcRenderer.invoke(desktopFilesChannels.pickDirectory),
    );
  },
  async saveArtifact(artifactId, name) {
    const request = desktopArtifactSaveSchema.parse({ id: artifactId, name });
    return desktopFileActionResultSchema.parse(
      await ipcRenderer.invoke(desktopFilesChannels.saveArtifact, request),
    );
  },
  async revealArtifact(artifactId) {
    const id = desktopArtifactIdSchema.parse(artifactId);
    return desktopFileActionResultSchema.parse(
      await ipcRenderer.invoke(desktopFilesChannels.revealArtifact, id),
    );
  },
};
contextBridge.exposeInMainWorld('atelierDesktopFiles', files);
