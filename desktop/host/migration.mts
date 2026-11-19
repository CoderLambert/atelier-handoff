/**
 * @file 提供旧版工作台数据的原生迁入流程。
 * @implementation 由 Electron 选择来源并确认，通过随包的 Node 运行迁移和回退校验。
 * @updated 2026-11-20T02:00+08:00
 */
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { dialog } from 'electron';
import { z } from 'zod';

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
    title: '选择旧版工作台的数据目录',
    message: '先退出使用该数据目录的旧版。请选择包含 atelier.sqlite 的目录。',
    properties: ['openDirectory', 'showHiddenFiles'],
  });
  const source = selected.filePaths[0];
  if (selected.canceled || !source || signal.aborted) return false;
  const answer = await dialog.showMessageBox({
    type: 'question',
    title: '迁入旧工作台数据',
    message: '将旧工作台迁入新目录？',
    detail: `来源 ${source}\n目标 ${dataDir}\n原项目目录及旧数据保留。网页可能需要重新登录。`,
    buttons: ['迁入', '取消'],
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
      title: '工作台数据已迁入',
      message: `已迁入 ${result.projects} 个项目和 ${result.sessions} 个会话`,
      detail: `附件 ${result.attachments} 个，交付物 ${result.artifacts} 个。\n回退副本 ${result.backupPath}`,
      buttons: ['打开工作台', '退出'],
      defaultId: 0,
      cancelId: 1,
      signal,
    });
    return complete.response === 0 && !signal.aborted;
  } catch (error) {
    if (signal.aborted) return false;
    const details =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String(error.stderr).trim().split('\n').at(-1)
        : undefined;
    await dialog.showMessageBox({
      type: 'error',
      title: '未迁入旧数据',
      message: details || '无法迁入所选工作台数据。',
      detail: '检查来源目录及目标位置，再启动迁入向导。',
      signal,
    });
    return false;
  }
}
