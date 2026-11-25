/**
 * @file 定义消息引用草稿和发送时的正文格式。
 * @implementation 校验普通引用及文件摘录的路径、行号和版本，限制数量与长度，将引用与来源格式化为发送正文。
 * @updated 2026-11-25T17:22:06+08:00
 */
import { z } from 'zod';
import { gitOid, gitPath } from './git-workbench.js';

export const composerTextLimit = 32_000;
export const messageQuoteLimit = 5;
const fileQuoteSource = z
  .strictObject({
    path: gitPath,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    version: z.enum(['worktree', 'index', 'head', 'commit', 'parent']),
    revision: gitOid.optional(),
    checkout: z.string().min(1).max(240).optional(),
  })
  .refine(
    (file) =>
      file.endLine >= file.startLine &&
      (file.version === 'commit' || file.version === 'parent') === Boolean(file.revision),
  );
export type FileQuoteSource = z.infer<typeof fileQuoteSource>;
export const messageQuotesSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(200),
      text: z.string().min(1).max(composerTextLimit),
      sourceMessageId: z.string().min(1).max(200).optional(),
      file: fileQuoteSource.optional(),
    }),
  )
  .max(messageQuoteLimit);
export type MessageQuote = z.infer<typeof messageQuotesSchema>[number];

export function fileQuoteLocation(file: FileQuoteSource): string {
  const ending = file.endLine === file.startLine ? '' : `-${file.endLine}`;
  return `${file.path}:${file.startLine}${ending}`;
}

function quoteText(quote: MessageQuote): string {
  const file = quote.file;
  if (!file) return quote.text;
  const version =
    file.version === 'parent'
      ? `parent of ${file.revision}`
      : file.version === 'commit'
        ? `commit ${file.revision}`
        : file.version === 'head'
          ? 'HEAD'
          : file.version;
  return `${fileQuoteLocation(file)} (${version}${file.checkout ? `, ${file.checkout}` : ''})\n${quote.text}`;
}

export function formatMessageText(text: string, quotes: readonly MessageQuote[] = []): string {
  return [
    text,
    ...quotes.map((quote) =>
      quoteText(quote)
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n'),
    ),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}
