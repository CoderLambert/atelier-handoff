/**
 * @file 管理可信工作台窗口的原生文件操作与诊断导出。
 * @implementation 校验 IPC 来源，通过系统对话框处理目录和保存操作；从配对运行时读取交付物或 Git 文件位置，定位本机文件并导出诊断信息。
 * @updated 2026-11-25T16:53:09+08:00
 */
import { randomUUID } from 'node:crypto';
import { access, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { release } from 'node:os';
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  desktopArtifactIdSchema,
  desktopArtifactSaveSchema,
  desktopFilesChannels,
  desktopGitFileSchema,
  desktopGitFileLocationSchema,
} from '../../shared/desktop-files.js';
import { desktopPairingHeader } from '../../shared/desktop-host.js';
import { desktopT } from './i18n.mjs';

type Connection = { origin: string; pairing: string };
export function createNativeFileActions(
  window: () => BrowserWindow | undefined,
  currentConnection: () => Connection | undefined,
) {
  const copies = new Map<string, string>();
  function trusted(event: IpcMainInvokeEvent) {
    const owner = window();
    const runtime = currentConnection();
    if (
      !owner ||
      owner.isDestroyed() ||
      !runtime ||
      owner.webContents.isDestroyed() ||
      event.sender !== owner.webContents ||
      event.senderFrame !== owner.webContents.mainFrame ||
      event.senderFrame.origin !== runtime.origin
    )
      throw new Error(desktopT('host.files.invalidSource'));
    return { owner, runtime };
  }

  ipcMain.handle(desktopFilesChannels.pickDirectory, async (event): Promise<string | null> => {
    const { owner } = trusted(event);
    const result = await dialog.showOpenDialog(owner, {
      title: desktopT('host.files.chooseDirectory'),
      buttonLabel: desktopT('host.files.chooseButton'),
      properties: ['openDirectory'],
    });
    trusted(event);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(
    desktopFilesChannels.saveArtifact,
    async (event, input: unknown): Promise<boolean> => {
      const { owner, runtime } = trusted(event);
      const { id, name } = desktopArtifactSaveSchema.parse(input);
      const result = await dialog.showSaveDialog(owner, {
        title: desktopT('host.files.saveArtifact'),
        buttonLabel: desktopT('host.files.saveButton'),
        defaultPath: name,
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      });
      if (result.canceled || !result.filePath) return false;
      if (trusted(event).runtime !== runtime)
        throw new Error(desktopT('host.files.connectionChanged'));
      const response = await fetch(new URL(`/api/artifacts/${id}/download`, runtime.origin), {
        headers: { [desktopPairingHeader]: runtime.pairing },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok)
        throw new Error(desktopT('host.files.readFailed'), { cause: `HTTP ${response.status}` });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 20 * 1024 * 1024) throw new Error(desktopT('host.files.tooLarge'));
      const path = result.filePath;
      const staged = join(dirname(path), `.atelier-save-${randomUUID()}`);
      try {
        await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 });
        if (trusted(event).runtime !== runtime)
          throw new Error(desktopT('host.files.connectionChanged'));
        await rename(staged, path);
        copies.set(id, path);
        return true;
      } catch (error) {
        await rm(staged, { force: true }).catch(() => {});
        if (error instanceof Error && 'code' in error)
          throw new Error(desktopT('host.files.saveFailed'), { cause: error });
        throw error;
      }
    },
  );

  ipcMain.handle(
    desktopFilesChannels.revealArtifact,
    async (event, input: unknown): Promise<boolean> => {
      trusted(event);
      const id = desktopArtifactIdSchema.parse(input);
      const path = copies.get(id);
      if (!path) return false;
      try {
        await access(path);
      } catch {
        copies.delete(id);
        return false;
      }
      trusted(event);
      shell.showItemInFolder(path);
      return true;
    },
  );
  ipcMain.handle(desktopFilesChannels.revealGitFile, async (event, input: unknown): Promise<boolean> => {
    const { runtime } = trusted(event);
    const { projectId, worktreeId, path } = desktopGitFileSchema.parse(input);
    const url = new URL(`/api/projects/${projectId}/git/worktrees/${worktreeId}/file-location`, runtime.origin);
    url.searchParams.set('path', path);
    const response = await fetch(url, {
      headers: { [desktopPairingHeader]: runtime.pairing },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!response.ok || trusted(event).runtime !== runtime) return false;
    const value: unknown = await response.json();
    const { location } = desktopGitFileLocationSchema.parse(value);
    if (!isAbsolute(location) || trusted(event).runtime !== runtime) return false;
    shell.showItemInFolder(location);
    return true;
  });
  ipcMain.handle(desktopFilesChannels.exportDiagnostics, async (event): Promise<boolean> => {
    const { owner } = trusted(event);
    const result = await dialog.showSaveDialog(owner, {
      title: desktopT('host.files.exportDiagnostics'),
      buttonLabel: desktopT('host.files.exportButton'),
      defaultPath: 'atelier-diagnostics.json',
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) return false;
    trusted(event);
    const info = {
      formatVersion: 1,
      applicationVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      chromiumVersion: process.versions.chrome,
      system: { platform: process.platform, architecture: process.arch, version: release() },
      packaged: app.isPackaged,
      runtime: 'connected',
      timestamp: new Date().toISOString(),
    };
    await writeFile(result.filePath, JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
    return true;
  });
  return { reset: () => copies.clear() };
}
