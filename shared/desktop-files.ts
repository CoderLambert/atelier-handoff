/**
 * @file 定义工作台原生文件操作与诊断导出的共享契约。
 * @implementation 声明 IPC 通道、桥接接口及运行时 schema，约束目录选择、交付物另存与定位、诊断导出的输入和返回值。
 * @updated 2026-11-20T03:34:05+08:00
 */
import { z } from 'zod';

export const desktopFilesChannels = {
  pickDirectory: 'files:pick-directory',
  saveArtifact: 'files:save-artifact',
  revealArtifact: 'files:reveal-artifact',
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

export interface DesktopFilesBridge {
  pickDirectory(): Promise<string | null>;
  saveArtifact(artifactId: string, name: string): Promise<boolean>;
  revealArtifact(artifactId: string): Promise<boolean>;
  exportDiagnostics(): Promise<boolean>;
}
