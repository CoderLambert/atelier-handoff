/**
 * @file 绑定桌面端 Git 操作的 IPC 通道。
 * @implementation 校验可信窗口与主 frame 来源，按共享契约解析合并请求并调用 Git 服务。
 * @updated 2026-11-27T01:02:41+08:00
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  desktopGitChannels,
  gitMergeRequestSchema,
  type GitFetchOptions,
  type GitPullOptions,
  type GitPushOptions,
  type GitResetMode,
} from '../../shared/desktop-git.js';
import {
  getGitCommitStats,
  getGitRepoStatus,
  gitAbortOp,
  gitAmendCommit,
  gitCheckoutBranch,
  gitCherryPick,
  gitCommit,
  gitContinueOp,
  gitCreateBranch,
  gitDeleteBranch,
  gitFetch,
  gitMergeBranch,
  gitPull,
  gitPush,
  gitRenameBranch,
  gitReset,
  gitRevert,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
} from './git-service.mjs';

type Connection = { origin: string };

function parseCwd(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null && 'cwd' in input) {
    const val = (input as { cwd: unknown }).cwd;
    if (typeof val === 'string') return val;
  }
  throw new Error('Missing or invalid cwd parameter.');
}

export function bindDesktopGit(
  getWindow: () => BrowserWindow | undefined,
  getConnection: () => Connection | undefined,
  isStopping: () => boolean,
): () => void {
  function trusted(event: IpcMainInvokeEvent): Connection {
    const owner = getWindow();
    const connection = getConnection();
    if (
      isStopping() ||
      !owner ||
      owner.isDestroyed() ||
      !connection ||
      owner.webContents.isDestroyed() ||
      event.sender !== owner.webContents ||
      event.senderFrame !== owner.webContents.mainFrame ||
      event.senderFrame?.origin !== connection.origin
    ) {
      throw new Error('Untrusted Git IPC request.');
    }
    return connection;
  }

  ipcMain.handle(desktopGitChannels.status, async (event, input: unknown) => {
    trusted(event);
    const cwd = parseCwd(input);
    return getGitRepoStatus(cwd);
  });

  ipcMain.handle(
    desktopGitChannels.commitStats,
    async (event, input: unknown, hashArg?: unknown) => {
      trusted(event);
      let cwd: string;
      let hash: string;
      if (typeof input === 'object' && input !== null && 'cwd' in input && 'hash' in input) {
        cwd = String((input as { cwd: unknown }).cwd);
        hash = String((input as { hash: unknown }).hash);
      } else {
        cwd = parseCwd(input);
        hash = typeof hashArg === 'string' ? hashArg : '';
      }
      if (!hash) throw new Error('Missing commit hash parameter.');
      return getGitCommitStats(cwd, hash);
    },
  );

  ipcMain.handle(desktopGitChannels.fetch, async (event, input: unknown, optsArg?: unknown) => {
    trusted(event);
    const cwd = parseCwd(input);
    const options =
      typeof input === 'object' && input !== null && !('remote' in input) && optsArg
        ? (optsArg as GitFetchOptions)
        : (input as GitFetchOptions);
    return gitFetch(cwd, options);
  });

  ipcMain.handle(desktopGitChannels.pull, async (event, input: unknown, optsArg?: unknown) => {
    trusted(event);
    const cwd = parseCwd(input);
    const options =
      typeof input === 'object' && input !== null && !('rebase' in input) && optsArg
        ? (optsArg as GitPullOptions)
        : (input as GitPullOptions);
    return gitPull(cwd, options);
  });

  ipcMain.handle(desktopGitChannels.push, async (event, input: unknown, optsArg?: unknown) => {
    trusted(event);
    const cwd = parseCwd(input);
    const options =
      typeof input === 'object' && input !== null && !('forceWithLease' in input) && optsArg
        ? (optsArg as GitPushOptions)
        : (input as GitPushOptions);
    return gitPush(cwd, options);
  });

  ipcMain.handle(
    desktopGitChannels.createBranch,
    async (event, input: unknown, nameArg?: unknown, startPointArg?: unknown) => {
      trusted(event);
      let cwd: string;
      let name: string;
      let startPoint: string | undefined;
      if (typeof input === 'object' && input !== null && 'name' in input) {
        cwd = parseCwd(input);
        name = String((input as { name: unknown }).name);
        startPoint =
          typeof (input as { startPoint?: unknown }).startPoint === 'string'
            ? String((input as { startPoint?: unknown }).startPoint)
            : undefined;
      } else {
        cwd = parseCwd(input);
        name = typeof nameArg === 'string' ? nameArg : '';
        startPoint = typeof startPointArg === 'string' ? startPointArg : undefined;
      }
      if (!name) throw new Error('Missing branch name parameter.');
      return gitCreateBranch(cwd, name, startPoint);
    },
  );

  ipcMain.handle(
    desktopGitChannels.checkoutBranch,
    async (event, input: unknown, nameArg?: unknown, autoStashArg?: unknown) => {
      trusted(event);
      let cwd: string;
      let name: string;
      let autoStash: boolean | undefined;
      if (typeof input === 'object' && input !== null && 'name' in input) {
        cwd = parseCwd(input);
        name = String((input as { name: unknown }).name);
        autoStash = Boolean((input as { autoStash?: unknown }).autoStash);
      } else {
        cwd = parseCwd(input);
        name = typeof nameArg === 'string' ? nameArg : '';
        autoStash = Boolean(autoStashArg);
      }
      if (!name) throw new Error('Missing branch name parameter.');
      return gitCheckoutBranch(cwd, name, autoStash);
    },
  );

  ipcMain.handle(
    desktopGitChannels.renameBranch,
    async (event, input: unknown, oldNameArg?: unknown, newNameArg?: unknown) => {
      trusted(event);
      let cwd: string;
      let oldName: string;
      let newName: string;
      if (
        typeof input === 'object' &&
        input !== null &&
        'oldName' in input &&
        'newName' in input
      ) {
        cwd = parseCwd(input);
        oldName = String((input as { oldName: unknown }).oldName);
        newName = String((input as { newName: unknown }).newName);
      } else {
        cwd = parseCwd(input);
        oldName = typeof oldNameArg === 'string' ? oldNameArg : '';
        newName = typeof newNameArg === 'string' ? newNameArg : '';
      }
      if (!oldName || !newName) throw new Error('Missing oldName or newName parameter.');
      return gitRenameBranch(cwd, oldName, newName);
    },
  );

  ipcMain.handle(
    desktopGitChannels.deleteBranch,
    async (event, input: unknown, nameArg?: unknown, forceArg?: unknown) => {
      trusted(event);
      let cwd: string;
      let name: string;
      let force: boolean | undefined;
      if (typeof input === 'object' && input !== null && 'name' in input) {
        cwd = parseCwd(input);
        name = String((input as { name: unknown }).name);
        force = Boolean((input as { force?: unknown }).force);
      } else {
        cwd = parseCwd(input);
        name = typeof nameArg === 'string' ? nameArg : '';
        force = Boolean(forceArg);
      }
      if (!name) throw new Error('Missing branch name parameter.');
      return gitDeleteBranch(cwd, name, force);
    },
  );

  ipcMain.handle(desktopGitChannels.mergeBranch, async (event, input: unknown) => {
    trusted(event);
    return gitMergeBranch(gitMergeRequestSchema.parse(input));
  });

  ipcMain.handle(
    desktopGitChannels.reset,
    async (event, input: unknown, hashArg?: unknown, modeArg?: unknown) => {
      trusted(event);
      let cwd: string;
      let hash: string;
      let mode: GitResetMode;
      if (typeof input === 'object' && input !== null && 'hash' in input && 'mode' in input) {
        cwd = parseCwd(input);
        hash = String((input as { hash: unknown }).hash);
        mode = (input as { mode: GitResetMode }).mode;
      } else {
        cwd = parseCwd(input);
        hash = typeof hashArg === 'string' ? hashArg : '';
        mode = (modeArg as GitResetMode) || 'mixed';
      }
      if (!hash) throw new Error('Missing hash parameter.');
      return gitReset(cwd, hash, mode);
    },
  );

  ipcMain.handle(desktopGitChannels.revert, async (event, input: unknown, hashArg?: unknown) => {
    trusted(event);
    let cwd: string;
    let hash: string;
    if (typeof input === 'object' && input !== null && 'hash' in input) {
      cwd = parseCwd(input);
      hash = String((input as { hash: unknown }).hash);
    } else {
      cwd = parseCwd(input);
      hash = typeof hashArg === 'string' ? hashArg : '';
    }
    if (!hash) throw new Error('Missing hash parameter.');
    return gitRevert(cwd, hash);
  });

  ipcMain.handle(desktopGitChannels.cherryPick, async (event, input: unknown, hashArg?: unknown) => {
    trusted(event);
    let cwd: string;
    let hash: string;
    if (typeof input === 'object' && input !== null && 'hash' in input) {
      cwd = parseCwd(input);
      hash = String((input as { hash: unknown }).hash);
    } else {
      cwd = parseCwd(input);
      hash = typeof hashArg === 'string' ? hashArg : '';
    }
    if (!hash) throw new Error('Missing hash parameter.');
    return gitCherryPick(cwd, hash);
  });

  ipcMain.handle(
    desktopGitChannels.commit,
    async (event, input: unknown, messageArg?: unknown, stageAllArg?: unknown) => {
      trusted(event);
      let cwd: string;
      let message: string;
      let stageAll = false;
      if (typeof input === 'object' && input !== null && 'message' in input) {
        cwd = parseCwd(input);
        message = String((input as { message: unknown }).message);
        stageAll = Boolean((input as { stageAll?: unknown }).stageAll);
      } else {
        cwd = parseCwd(input);
        message = typeof messageArg === 'string' ? messageArg : '';
        stageAll = Boolean(stageAllArg);
      }
      if (!message) throw new Error('Missing commit message parameter.');
      return gitCommit(cwd, message, stageAll);
    },
  );

  ipcMain.handle(
    desktopGitChannels.amendCommit,
    async (event, input: unknown, messageArg?: unknown, stageAllArg?: unknown) => {
      trusted(event);
      let cwd: string;
      let message: string;
      let stageAll = false;
      if (typeof input === 'object' && input !== null && 'message' in input) {
        cwd = parseCwd(input);
        message = String((input as { message: unknown }).message);
        stageAll = Boolean((input as { stageAll?: unknown }).stageAll);
      } else {
        cwd = parseCwd(input);
        message = typeof messageArg === 'string' ? messageArg : '';
        stageAll = Boolean(stageAllArg);
      }
      if (!message) throw new Error('Missing commit message parameter.');
      return gitAmendCommit(cwd, message, stageAll);
    },
  );

  ipcMain.handle(desktopGitChannels.stashList, async (event, input: unknown) => {
    trusted(event);
    const cwd = parseCwd(input);
    return gitStashList(cwd);
  });

  ipcMain.handle(
    desktopGitChannels.stashPush,
    async (event, input: unknown, messageArg?: unknown) => {
      trusted(event);
      let cwd: string;
      let message: string | undefined;
      if (typeof input === 'object' && input !== null && 'message' in input) {
        cwd = parseCwd(input);
        message =
          typeof (input as { message?: unknown }).message === 'string'
            ? String((input as { message?: unknown }).message)
            : undefined;
      } else {
        cwd = parseCwd(input);
        message = typeof messageArg === 'string' ? messageArg : undefined;
      }
      return gitStashPush(cwd, message);
    },
  );

  ipcMain.handle(desktopGitChannels.stashPop, async (event, input: unknown, indexArg?: unknown) => {
    trusted(event);
    let cwd: string;
    let index: number | undefined;
    if (typeof input === 'object' && input !== null && 'index' in input) {
      cwd = parseCwd(input);
      index =
        typeof (input as { index?: unknown }).index === 'number'
          ? Number((input as { index?: unknown }).index)
          : undefined;
    } else {
      cwd = parseCwd(input);
      index = typeof indexArg === 'number' ? indexArg : undefined;
    }
    return gitStashPop(cwd, index);
  });

  ipcMain.handle(
    desktopGitChannels.stashApply,
    async (event, input: unknown, indexArg?: unknown) => {
      trusted(event);
      let cwd: string;
      let index: number | undefined;
      if (typeof input === 'object' && input !== null && 'index' in input) {
        cwd = parseCwd(input);
        index =
          typeof (input as { index?: unknown }).index === 'number'
            ? Number((input as { index?: unknown }).index)
            : undefined;
      } else {
        cwd = parseCwd(input);
        index = typeof indexArg === 'number' ? indexArg : undefined;
      }
      return gitStashApply(cwd, index);
    },
  );

  ipcMain.handle(desktopGitChannels.stashDrop, async (event, input: unknown, indexArg?: unknown) => {
    trusted(event);
    let cwd: string;
    let index: number | undefined;
    if (typeof input === 'object' && input !== null && 'index' in input) {
      cwd = parseCwd(input);
      index =
        typeof (input as { index?: unknown }).index === 'number'
          ? Number((input as { index?: unknown }).index)
          : undefined;
    } else {
      cwd = parseCwd(input);
      index = typeof indexArg === 'number' ? indexArg : undefined;
    }
    return gitStashDrop(cwd, index);
  });

  ipcMain.handle(desktopGitChannels.continueOp, async (event, input: unknown) => {
    trusted(event);
    const cwd = parseCwd(input);
    return gitContinueOp(cwd);
  });

  ipcMain.handle(desktopGitChannels.abortOp, async (event, input: unknown) => {
    trusted(event);
    const cwd = parseCwd(input);
    return gitAbortOp(cwd);
  });

  return () => {
    for (const channel of Object.values(desktopGitChannels)) {
      ipcMain.removeHandler(channel);
    }
  };
}
