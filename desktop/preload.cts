/**
 * @file 向渲染进程提供受限的桌面能力桥接。
 * @implementation 通过 Electron IPC 转发浏览器、文件、界面设置、通知和 Git 操作，校验适用的请求及响应并管理浏览器状态订阅。
 * @updated 2026-11-25T16:31:33+08:00
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  desktopBrowserChannels,
  desktopBrowserCommandSchema,
  desktopBrowserDownloadPreviewSchema,
  desktopBrowserReadDownloadSchema,
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
        : action === 'cancel-download' || action === 'reveal-download' || action === 'open-download'
          ? { downloadId: value }
          : action === 'navigate' || action === 'open-tab' || action === 'open-external'
            ? { url: value }
            : {}),
    });
    const response: unknown = await ipcRenderer.invoke(desktopBrowserChannels.command, request);
    if (response !== undefined) throw new Error('浏览器返回了无效响应。');
  },
  async readDownload(projectId, downloadId) {
    const request = desktopBrowserReadDownloadSchema.parse({ projectId, downloadId });
    const response: unknown = await ipcRenderer.invoke(
      desktopBrowserChannels.readDownload,
      request,
    );
    return desktopBrowserDownloadPreviewSchema.parse(response);
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
  desktopGitFileSchema,
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
  async revealGitFile(file) {
    return desktopFileActionResultSchema.parse(
      await ipcRenderer.invoke(desktopFilesChannels.revealGitFile, desktopGitFileSchema.parse(file)),
    );
  },
};
contextBridge.exposeInMainWorld('atelierDesktopFiles', files);

import {
  desktopUiLanguageChannels,
  desktopUiLanguageGetSchema,
  desktopUiLanguageSetSchema,
  desktopUiLanguageResultSchema,
  type DesktopUiLanguageBridge,
} from '../shared/desktop-ui-language.js';

const uiLanguage: DesktopUiLanguageBridge = {
  async get() {
    const request = desktopUiLanguageGetSchema.parse(undefined);
    const response: unknown = await ipcRenderer.invoke(desktopUiLanguageChannels.get, request);
    return desktopUiLanguageResultSchema.parse(response);
  },
  async set(locale) {
    const request = desktopUiLanguageSetSchema.parse(locale);
    const response: unknown = await ipcRenderer.invoke(desktopUiLanguageChannels.set, request);
    return desktopUiLanguageResultSchema.parse(response);
  },
};
contextBridge.exposeInMainWorld('atelierUiLanguage', uiLanguage);

import {
  desktopUiThemeChannels,
  desktopUiThemeGetSchema,
  desktopUiThemeResultSchema,
  desktopUiThemeSetSchema,
  type DesktopUiThemeBridge,
} from '../shared/desktop-ui-theme.js';

const uiTheme: DesktopUiThemeBridge = {
  async get() {
    const request = desktopUiThemeGetSchema.parse(undefined);
    const response: unknown = await ipcRenderer.invoke(desktopUiThemeChannels.get, request);
    return desktopUiThemeResultSchema.parse(response);
  },
  async set(theme) {
    const request = desktopUiThemeSetSchema.parse(theme);
    const response: unknown = await ipcRenderer.invoke(desktopUiThemeChannels.set, request);
    return desktopUiThemeResultSchema.parse(response);
  },
};
contextBridge.exposeInMainWorld('atelierUiTheme', uiTheme);

import {
  desktopUiNotificationChannels,
  desktopUiNotificationGetSchema,
  desktopUiNotificationResultSchema,
  desktopUiNotificationSetSchema,
  desktopWindowFocusResultSchema,
  type DesktopUiNotificationsBridge,
} from '../shared/desktop-ui-notifications.js';

const uiNotifications: DesktopUiNotificationsBridge = {
  async get() {
    const request = desktopUiNotificationGetSchema.parse(undefined);
    const response: unknown = await ipcRenderer.invoke(desktopUiNotificationChannels.get, request);
    return desktopUiNotificationResultSchema.parse(response);
  },
  async set(notifications) {
    const request = desktopUiNotificationSetSchema.parse(notifications);
    const response: unknown = await ipcRenderer.invoke(desktopUiNotificationChannels.set, request);
    return desktopUiNotificationResultSchema.parse(response);
  },
  async focusWindow() {
    const response: unknown = await ipcRenderer.invoke(desktopUiNotificationChannels.focusWindow);
    return desktopWindowFocusResultSchema.parse(response);
  },
};
contextBridge.exposeInMainWorld('atelierUiNotifications', uiNotifications);

import {
  desktopGitChannels,
  gitCommitStatsSchema,
  gitOpResultSchema,
  gitRepoStatusSchema,
  gitStashItemSchema,
  type DesktopGitBridge,
} from '../shared/desktop-git.js';

const gitBridge: DesktopGitBridge = {
  async getStatus(cwd) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.status, { cwd });
    return gitRepoStatusSchema.parse(response);
  },
  async getCommitStats(cwd, hash) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.commitStats, {
      cwd,
      hash,
    });
    return gitCommitStatsSchema.parse(response);
  },
  async fetch(cwd, options) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.fetch, {
      cwd,
      ...options,
    });
    return gitOpResultSchema.parse(response);
  },
  async pull(cwd, options) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.pull, {
      cwd,
      ...options,
    });
    return gitOpResultSchema.parse(response);
  },
  async push(cwd, options) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.push, {
      cwd,
      ...options,
    });
    return gitOpResultSchema.parse(response);
  },
  async createBranch(cwd, name, startPoint) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.createBranch, {
      cwd,
      name,
      startPoint,
    });
    return gitOpResultSchema.parse(response);
  },
  async checkoutBranch(cwd, name, autoStash) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.checkoutBranch, {
      cwd,
      name,
      autoStash,
    });
    return gitOpResultSchema.parse(response);
  },
  async renameBranch(cwd, oldName, newName) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.renameBranch, {
      cwd,
      oldName,
      newName,
    });
    return gitOpResultSchema.parse(response);
  },
  async deleteBranch(cwd, name, force) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.deleteBranch, {
      cwd,
      name,
      force,
    });
    return gitOpResultSchema.parse(response);
  },
  async mergeBranch(cwd, name) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.mergeBranch, {
      cwd,
      name,
    });
    return gitOpResultSchema.parse(response);
  },
  async reset(cwd, hash, mode) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.reset, {
      cwd,
      hash,
      mode,
    });
    return gitOpResultSchema.parse(response);
  },
  async revert(cwd, hash) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.revert, { cwd, hash });
    return gitOpResultSchema.parse(response);
  },
  async cherryPick(cwd, hash) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.cherryPick, {
      cwd,
      hash,
    });
    return gitOpResultSchema.parse(response);
  },
  async commit(cwd, message, stageAll) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.commit, {
      cwd,
      message,
      stageAll,
    });
    return gitOpResultSchema.parse(response);
  },
  async amendCommit(cwd, message, stageAll) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.amendCommit, {
      cwd,
      message,
      stageAll,
    });
    return gitOpResultSchema.parse(response);
  },
  async stashList(cwd) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.stashList, { cwd });
    if (!Array.isArray(response)) return [];
    return response.map((item) => gitStashItemSchema.parse(item));
  },
  async stashPush(cwd, message) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.stashPush, {
      cwd,
      message,
    });
    return gitOpResultSchema.parse(response);
  },
  async stashPop(cwd, index) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.stashPop, {
      cwd,
      index,
    });
    return gitOpResultSchema.parse(response);
  },
  async stashApply(cwd, index) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.stashApply, {
      cwd,
      index,
    });
    return gitOpResultSchema.parse(response);
  },
  async stashDrop(cwd, index) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.stashDrop, {
      cwd,
      index,
    });
    return gitOpResultSchema.parse(response);
  },
  async continueOp(cwd) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.continueOp, { cwd });
    return gitOpResultSchema.parse(response);
  },
  async abortOp(cwd) {
    const response: unknown = await ipcRenderer.invoke(desktopGitChannels.abortOp, { cwd });
    return gitOpResultSchema.parse(response);
  },
};

contextBridge.exposeInMainWorld('atelierGit', gitBridge);
