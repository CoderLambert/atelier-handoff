/**
 * @file 定义可由工作台调用的原生文件操作。
 * @implementation 限定目录选择和交付物另存、定位的请求及返回值。
 * @updated 2026-11-20T02:00+08:00
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
