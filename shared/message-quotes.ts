/**
 * @file 定义消息引用草稿和发送时的正文格式。
 * @implementation 校验引用快照及可选的来源消息标识，限制引用数量和文本长度，并将引用格式化为发送正文。
 * @updated 2026-11-23T01:25:15+08:00
 */
import { z } from 'zod';

export const composerTextLimit = 32_000;
export const messageQuoteLimit = 5;
export const messageQuotesSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(200),
      text: z.string().min(1).max(composerTextLimit),
      sourceMessageId: z.string().min(1).max(200).optional(),
    }),
  )
  .max(messageQuoteLimit);
export type MessageQuote = z.infer<typeof messageQuotesSchema>[number];

export function formatMessageText(text: string, quotes: readonly MessageQuote[] = []): string {
  return [
    text,
    ...quotes.map((quote) =>
      quote.text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n'),
    ),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}
