/**
 * @file 验证代码摘录的草稿兼容与发送格式。
 * @implementation 核对来源元数据保留、行号区间校验及代码缩进。
 * @updated 2026-11-25T17:20:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMessageText, messageQuotesSchema } from '../shared/message-quotes.js';

test('code quotes retain the file version and line range alongside ordinary quotes', () => {
  const file = { path: 'src/sample.ts', startLine: 11, endLine: 12, version: 'index' } as const;
  const quotes = messageQuotesSchema.parse([
    { id: 'previous', text: 'Old quote', sourceMessageId: 'assistant' },
    { id: 'file', text: '  first();\n  second();', file },
  ]);
  assert.deepEqual(quotes[1]?.file, file);
  assert.equal(
    formatMessageText('Review this', quotes),
    'Review this\n\n> Old quote\n\n> src/sample.ts:11-12 (index)\n>   first();\n>   second();',
  );
  assert.equal(
    messageQuotesSchema.safeParse([{ id: 'bad', text: 'text', file: { ...file, endLine: 10 } }])
      .success,
    false,
  );
});
