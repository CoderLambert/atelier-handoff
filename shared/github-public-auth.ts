/**
 * @file 定义公开 GitHub 导入的连接状态。
 * @implementation 共享本机 GitHub CLI 账号名和连接操作的运行时校验。
 * @updated 2026-11-26T15:40:00+08:00
 */
import { z } from 'zod';
export const githubLogin = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/i);
export const githubPublicAuthView = z.object({ login: githubLogin.nullable() });
export const githubPublicAuthPatch = z.strictObject({ connect: z.boolean() });
