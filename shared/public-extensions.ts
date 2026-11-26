/**
 * @file 定义公开来源预览和导入版本契约。
 * @implementation 共享项目安装请求、GitHub 固定版本及不含文件数据的预览清单。
 * @updated 2026-11-26T12:00:00+08:00
 */
import { z } from 'zod';
import type { McpTransport } from './types.js';

export const githubSkillVersionSchema = z.object({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  ref: z.string().min(1).max(1024),
  path: z.string().max(1024),
});
export type GithubSkillVersion = z.infer<typeof githubSkillVersionSchema>;

const publicSource = {
  source: z.string().trim().min(1).max(4096),
  kind: z.enum(['skill', 'command', 'mcp']),
  github: githubSkillVersionSchema.optional(),
};
export const publicPreviewSchema = z.object(publicSource);
export const publicImportSchema = z.object({
  ...publicSource,
  key: z.string().max(4096),
  revision: z.string().min(1).max(128),
  packageDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  update: z.object({ id: z.string().uuid(), version: z.number().int().positive() }).optional(),
});
export type PublicPreviewInput = z.infer<typeof publicPreviewSchema>;
export type PublicImportInput = z.infer<typeof publicImportSchema>;

export interface PublicEntry {
  location: string;
  key: string;
  name: string;
  description: string;
  kind: PublicPreviewInput['kind'];
  revision?: string;
  sha256?: string;
  upstreamName?: string;
  upstreamVersion?: string;
  github?: GithubSkillVersion;
  recommended?: boolean;
  packageManifest?: { digest: string; files: string[]; executables?: string[] };
  body?: string;
  transport?: McpTransport;
  issue?: string;
  compatibility?: string;
}
