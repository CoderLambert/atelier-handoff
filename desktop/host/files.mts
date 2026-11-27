/**
 * @file 管理可信工作台窗口的原生文件操作与诊断导出。
 * @implementation 通过共享来源守卫复核关停与连接状态，处理原生文件对话框、交付物保存、本机定位和诊断导出。
 * @updated 2026-11-27T16:55:43+08:00
 */
import { randomUUID } from 'node:crypto';
import { access, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { release } from 'node:os';
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import {
  desktopArtifactIdSchema,
  desktopArtifactSaveSchema,
  desktopFilesChannels,
  desktopGitFileSchema,
  desktopGitFileLocationSchema,
} from '../../shared/desktop-files.js';
import { desktopPairingHeader } from '../../shared/desktop-host.js';
import { desktopT } from './i18n.mjs';
import { createTrustedIpcGuard } from './trusted-ipc.mjs';

type Connection = { origin: string; pairing: string };
export function createNativeFileActions(
  window: () => BrowserWindow | undefined,
  currentConnection: () => Connection | undefined,
  isStopping: () => boolean,
) {
  const copies = new Map<string, string>();
  const assertTrustedIpc = createTrustedIpcGuard(window, currentConnection, isStopping, () =>
    desktopT('host.files.invalidSource'),
  );

  ipcMain.handle(desktopFilesChannels.pickDirectory, async (event): Promise<string | null> => {
    const { owner } = assertTrustedIpc(event);
    const result = await dialog.showOpenDialog(owner, {
      title: desktopT('host.files.chooseDirectory'),
      buttonLabel: desktopT('host.files.chooseButton'),
      properties: ['openDirectory'],
    });
    assertTrustedIpc(event);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(
    desktopFilesChannels.saveArtifact,
    async (event, input: unknown): Promise<boolean> => {
      const { owner, connection: runtime } = assertTrustedIpc(event);
      const { id, name } = desktopArtifactSaveSchema.parse(input);
      const result = await dialog.showSaveDialog(owner, {
        title: desktopT('host.files.saveArtifact'),
        buttonLabel: desktopT('host.files.saveButton'),
        defaultPath: name,
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      });
      if (result.canceled || !result.filePath) return false;
      if (assertTrustedIpc(event).connection !== runtime)
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
        if (assertTrustedIpc(event).connection !== runtime)
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
      assertTrustedIpc(event);
      const id = desktopArtifactIdSchema.parse(input);
      const path = copies.get(id);
      if (!path) return false;
      try {
        await access(path);
      } catch {
        copies.delete(id);
        return false;
      }
      assertTrustedIpc(event);
      shell.showItemInFolder(path);
      return true;
    },
  );
  ipcMain.handle(
    desktopFilesChannels.revealGitFile,
    async (event, input: unknown): Promise<boolean> => {
      const { connection: runtime } = assertTrustedIpc(event);
      const { projectId, worktreeId, path } = desktopGitFileSchema.parse(input);
      const url = new URL(
        `/api/projects/${projectId}/git/worktrees/${worktreeId}/file-location`,
        runtime.origin,
      );
      url.searchParams.set('path', path);
      const response = await fetch(url, {
        headers: { [desktopPairingHeader]: runtime.pairing },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok || assertTrustedIpc(event).connection !== runtime) return false;
      const value: unknown = await response.json();
      const { location } = desktopGitFileLocationSchema.parse(value);
      if (!isAbsolute(location) || assertTrustedIpc(event).connection !== runtime) return false;
      shell.showItemInFolder(location);
      return true;
    },
  );
  ipcMain.handle(desktopFilesChannels.exportDiagnostics, async (event): Promise<boolean> => {
    const { owner } = assertTrustedIpc(event);
    const result = await dialog.showSaveDialog(owner, {
      title: desktopT('host.files.exportDiagnostics'),
      buttonLabel: desktopT('host.files.exportButton'),
      defaultPath: 'atelier-diagnostics.json',
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) return false;
    assertTrustedIpc(event);
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
