/**
 * @file 定义独立文本增强的用途和请求响应契约。
 * @implementation 保留草稿正文的原始格式，复用聊天正文长度上限并拒绝空白。
 * @updated 2026-11-28T18:00:00+08:00
 */
import { z } from 'zod';
import { composerTextLimit } from './message-quotes.js';

const enhancementText = z
  .string()
  .max(composerTextLimit)
  .refine((text) => text.trim().length > 0);

export const textEnhancementRequest = z.strictObject({
  kind: z.literal('instruction'),
  text: enhancementText,
});
export const textEnhancementResult = z.strictObject({ text: enhancementText });
export type TextEnhancementRequest = z.infer<typeof textEnhancementRequest>;
