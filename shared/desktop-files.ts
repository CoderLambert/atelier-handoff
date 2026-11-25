/**
 * @file 定义工作台原生文件操作与诊断导出的共享契约。
 * @implementation 声明 IPC 通道、桥接接口及校验结构，约束目录选择、交付物另存与定位、Git 文件定位和诊断导出。
 * @updated 2026-11-25T16:53:09+08:00
 */
import { z } from 'zod';
import { gitPath } from './git-workbench.js';

export const desktopFilesChannels = {
  pickDirectory: 'files:pick-directory',
  saveArtifact: 'files:save-artifact',
  revealArtifact: 'files:reveal-artifact',
  revealGitFile: 'files:reveal-git-file',
  exportDiagnostics: 'files:export-diagnostics',
} as const;
export const desktopArtifactIdSchema = z.uuid();
export const desktopArtifactSaveSchema = z.strictObject({
  id: desktopArtifactIdSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[^\\/\u0000-\u001f]+$/),
});
export const desktopDirectoryResultSchema = z.string().min(1).nullable();
export const desktopFileActionResultSchema = z.boolean();
export const desktopGitFileSchema = z.strictObject({
  projectId: z.uuid(),
  worktreeId: z.uuid(),
  path: gitPath,
});
export const desktopGitFileLocationSchema = z.strictObject({ location: z.string().min(1) });
export type DesktopGitFile = z.infer<typeof desktopGitFileSchema>;

export interface DesktopFilesBridge {
  pickDirectory(): Promise<string | null>;
  saveArtifact(artifactId: string, name: string): Promise<boolean>;
  revealArtifact(artifactId: string): Promise<boolean>;
  revealGitFile(file: DesktopGitFile): Promise<boolean>;
  exportDiagnostics(): Promise<boolean>;
}
