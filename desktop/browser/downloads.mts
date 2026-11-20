/**
 * @file 管理项目浏览器下载、显示状态和文件位置。
 * @implementation 使用 Electron 下载事件获取进度，在系统下载目录发布完成文件，并按项目核对取消或定位请求。
 * @updated 2026-11-20T18:15:00+08:00
 */
import { app, shell, type DownloadItem, type Session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, mkdtempSync } from 'node:fs';
import { copyFile, link, lstat, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DesktopBrowserDownload } from '../../shared/desktop-browser.js';

interface Transfer {
  projectId: string;
  entry: DesktopBrowserDownload;
  item?: DownloadItem;
  lastUpdate: number;
}

function safeFilename(input: string) {
  // Remove path separators and characters reserved by the desktop platforms.
  const filename = Array.from(input, (character) =>
    character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/u.test(character) ? '_' : character,
  )
    .join('')
    .trim()
    .replace(/^\.+|[. ]+$/gu, '');
  if (!filename) return 'download';
  const extension = extname(filename);
  const base = filename.slice(0, filename.length - extension.length).slice(0, 56);
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(base);
  return `${reserved ? '_' : ''}${base}${extension.slice(0, 18)}`;
}

interface DownloadSource {
  projectId: string;
  findLinkTitle(url: string): Promise<string | undefined>;
}

function usesOpaqueName(filename: string, link: string): boolean {
  if (!URL.canParse(link) || !/^\.[a-z0-9]{1,10}$/iu.test(extname(filename))) return false;
  const pathname = new URL(link).pathname;
  const encodedName = pathname.slice(pathname.lastIndexOf('/') + 1);
  const basename = filename.slice(0, filename.length - extname(filename).length);
  return /^[a-f0-9]{24,64}$/iu.test(basename) && filename === encodedName;
}

export function createBrowserDownloads(
  publishState: (projectId: string) => void,
  sourceForDownload: (contents: WebContents, url: string) => DownloadSource | undefined,
) {
  const observed = new WeakSet<Session>();
  const transfers = new Map<string, Transfer>();
  const reservedPaths = new Set<string>();
  const directory = () => app.getPath('downloads');

  function availablePath(name: string): string {
    const suffix = extname(name);
    const base = name.slice(0, name.length - suffix.length);
    let path = join(directory(), name);
    for (
      let index = 1;
      reservedPaths.has(path) || lstatSync(path, { throwIfNoEntry: false });
      index++
    )
      path = join(directory(), `${base} (${index})${suffix}`);
    return path;
  }

  function notify(transfer: Transfer) {
    if (transfers.get(transfer.entry.id) === transfer) publishState(transfer.projectId);
  }

  async function saveCompleted(transfer: Transfer, staging: string) {
    while (true) {
      try {
        await link(staging, transfer.entry.path).catch(async (error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['EPERM', 'ENOTSUP', 'EXDEV'].includes(code ?? '')) throw error;
          await copyFile(staging, transfer.entry.path, constants.COPYFILE_EXCL);
        });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        reservedPaths.delete(transfer.entry.path);
        transfer.entry.path = availablePath(transfer.entry.filename);
        reservedPaths.add(transfer.entry.path);
      }
    }
  }

  function observe(session: Session) {
    if (observed.has(session)) return;
    observed.add(session);
    session.on('will-download', (event, item, contents) => {
      const source = sourceForDownload(contents, item.getURL());
      if (!source) {
        event.preventDefault();
        return;
      }
      const { projectId } = source;
      const id = randomUUID();
      const suggestedFilename = item.getFilename();
      const filename = safeFilename(suggestedFilename);
      const originalUrl = item.getURLChain()[0] ?? item.getURL();
      const transfer: Transfer = {
        projectId,
        entry: {
          id,
          filename,
          path: join(directory(), filename),
          receivedBytes: 0,
          totalBytes: item.getTotalBytes(),
          status: 'progressing',
        },
        item,
        lastUpdate: 0,
      };
      transfers.set(id, transfer);
      const older = [...transfers.values()].filter(
        (entry) => entry.projectId === projectId && entry.entry.status !== 'progressing',
      );
      for (const entry of older.slice(0, Math.max(0, older.length - 19)))
        transfers.delete(entry.entry.id);
      let temporary: string | undefined;
      let reserved = false;
      const refreshBytes = () => {
        transfer.entry.receivedBytes = item.getReceivedBytes();
        transfer.entry.totalBytes = item.getTotalBytes();
      };
      try {
        mkdirSync(directory(), { recursive: true });
        transfer.entry.path = availablePath(filename);
        temporary = mkdtempSync(join(directory(), '.atelier-download-'));
        const staging = join(temporary, 'download');
        reservedPaths.add(transfer.entry.path);
        reserved = true;
        item.setSavePath(staging);
        const nameReady = usesOpaqueName(suggestedFilename, originalUrl)
          ? Promise.race([source.findLinkTitle(originalUrl), delay(500, undefined, { ref: false })])
              .then((title) => {
                const label = title?.replace(/\s+/gu, ' ').trim();
                if (!label || /^(?:点击)?下载(?:附件|文件)?$/u.test(label)) return;
                const suffix = extname(filename);
                const basename =
                  suffix && label.toLowerCase().endsWith(suffix.toLowerCase())
                    ? label.slice(0, -suffix.length)
                    : label;
                const name = safeFilename(basename + suffix);
                if (name === filename || transfers.get(id) !== transfer) return;
                const path = availablePath(name);
                reservedPaths.delete(transfer.entry.path);
                reservedPaths.add(path);
                transfer.entry.filename = name;
                transfer.entry.path = path;
                notify(transfer);
              })
              .catch(() => {})
          : undefined;
        item.on('updated', (_event, state) => {
          refreshBytes();
          transfer.entry.error =
            state === 'interrupted' ? '下载连接中断，正在等待恢复。' : undefined;
          if (Date.now() - transfer.lastUpdate >= 120) {
            transfer.lastUpdate = Date.now();
            notify(transfer);
          }
        });
        const cleanup = temporary;
        item.once('done', (_event, status) => {
          refreshBytes();
          transfer.item = undefined;
          void (async () => {
            try {
              if (status === 'completed') {
                await nameReady;
                await saveCompleted(transfer, staging);
              }
              transfer.entry.status = status;
              transfer.entry.error =
                status === 'interrupted' ? '下载中断，请重新打开下载链接。' : undefined;
            } catch {
              transfer.entry.status = 'interrupted';
              transfer.entry.error = '下载文件无法保存到下载目录。';
            } finally {
              reservedPaths.delete(transfer.entry.path);
              await rm(cleanup, { recursive: true, force: true }).catch(() => {});
              notify(transfer);
            }
          })();
        });
      } catch {
        event.preventDefault();
        if (reserved) reservedPaths.delete(transfer.entry.path);
        transfer.item = undefined;
        transfer.entry.status = 'interrupted';
        transfer.entry.error = '无法在下载目录创建文件。';
        if (temporary) void rm(temporary, { recursive: true, force: true }).catch(() => {});
      }
      notify(transfer);
    });
  }

  function lookup(projectId: string, id: string): Transfer {
    const transfer = transfers.get(id);
    if (!transfer || transfer.projectId !== projectId) throw new Error('找不到这条下载。');
    return transfer;
  }

  return {
    directory,
    observe,
    list(projectId: string) {
      return [...transfers.values()]
        .filter((transfer) => transfer.projectId === projectId)
        .map((transfer) => transfer.entry)
        .reverse();
    },
    cancel(projectId: string, id: string) {
      lookup(projectId, id).item?.cancel();
    },
    async reveal(projectId: string, id: string) {
      const { entry } = lookup(projectId, id);
      if (entry.status !== 'completed') throw new Error('下载文件尚未保存。');
      const file = await lstat(entry.path).catch(() => undefined);
      if (!file?.isFile()) throw new Error('下载文件已移动或删除。');
      shell.showItemInFolder(entry.path);
    },
    async openDirectory() {
      mkdirSync(directory(), { recursive: true });
      const error = await shell.openPath(directory());
      if (error) throw new Error('无法打开系统下载目录。');
    },
    reset() {
      const active = [...transfers.values()];
      transfers.clear();
      for (const transfer of active) transfer.item?.cancel();
    },
  };
}
