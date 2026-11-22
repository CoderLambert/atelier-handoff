/**
 * @file 提供旧版工作台数据的原生迁入流程。
 * @implementation 通过原生对话框确认来源，调用随包 Node 迁入并展示回退副本位置。
 * @updated 2026-11-20T02:00+08:00
 */
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { dialog } from 'electron';
import { z } from 'zod';
import { desktopT, diagnosticText, formatDesktopNumber } from './i18n.mjs';

const run = promisify(execFile);
const report = z.object({
  projects: z.int().nonnegative(),
  sessions: z.int().nonnegative(),
  artifacts: z.int().nonnegative(),
  attachments: z.int().nonnegative(),
  backupPath: z.string(),
});

export async function importWorkspace(options: {
  runtimeRoot: string;
  dataDir: string;
  packaged: boolean;
  signal: AbortSignal;
}): Promise<boolean> {
  const { runtimeRoot, dataDir, packaged, signal } = options;
  const selected = await dialog.showOpenDialog({
    title: desktopT('host.migration.chooseTitle'),
    message: desktopT('host.migration.chooseMessage'),
    buttonLabel: desktopT('host.migration.chooseButton'),
    properties: ['openDirectory', 'showHiddenFiles'],
  });
  const source = selected.filePaths[0];
  if (selected.canceled || !source || signal.aborted) return false;
  const answer = await dialog.showMessageBox({
    type: 'question',
    title: desktopT('host.migration.confirmTitle'),
    message: desktopT('host.migration.confirmMessage'),
    detail: desktopT('host.migration.confirmDetail', { source, destination: dataDir }),
    buttons: [desktopT('host.migration.import'), desktopT('host.action.cancel')],
    defaultId: 0,
    cancelId: 1,
    signal,
  });
  if (answer.response !== 0 || signal.aborted) return false;
  try {
    await mkdir(dirname(dataDir), { recursive: true, mode: 0o700 });
    const node = packaged
      ? join(runtimeRoot, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
      : 'node';
    const args = [
      ...(packaged ? [] : ['--import', 'tsx']),
      join(runtimeRoot, packaged ? 'server/migrate-data.js' : 'server/migrate-data.ts'),
      source,
      dataDir,
    ];
    const { stdout } = await run(node, args, {
      cwd: runtimeRoot,
      signal,
      maxBuffer: 64 * 1024,
      env: packaged ? { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } : process.env,
    });
    const result = report.parse(JSON.parse(stdout));
    const complete = await dialog.showMessageBox({
      type: 'info',
      title: desktopT('host.migration.completeTitle'),
      message: desktopT('host.migration.completeMessage', {
        projects: formatDesktopNumber(result.projects),
        sessions: formatDesktopNumber(result.sessions),
      }),
      detail: desktopT('host.migration.completeDetail', {
        attachments: formatDesktopNumber(result.attachments),
        artifacts: formatDesktopNumber(result.artifacts),
        backupPath: result.backupPath,
      }),
      buttons: [desktopT('host.migration.open'), desktopT('host.action.exit')],
      defaultId: 0,
      cancelId: 1,
      signal,
    });
    return complete.response === 0 && !signal.aborted;
  } catch (error) {
    if (signal.aborted) return false;
    const diagnostic =
      typeof error === 'object' &&
      error !== null &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      error.stderr.trim()
        ? error.stderr.trim()
        : diagnosticText(error);
    const detail = desktopT('host.migration.failedDetail');
    await dialog.showMessageBox({
      type: 'error',
      title: desktopT('host.migration.failedTitle'),
      message: desktopT('host.migration.failedMessage'),
      detail: diagnostic
        ? `${detail}\n\n${desktopT('host.recovery.diagnostic', { diagnostic })}`
        : detail,
      buttons: [desktopT('host.action.ok')],
      signal,
    });
    return false;
  }
}
