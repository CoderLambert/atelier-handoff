/**
 * @file 向渲染进程提供桌面浏览器桥接接口。
 * @implementation 校验请求与状态，通过 Electron IPC 转发并管理订阅。
 * @updated 2026-11-20T02:00+08:00
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
        : action === 'navigate'
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
