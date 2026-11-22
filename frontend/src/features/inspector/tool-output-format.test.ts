/**
 * @file 检查工具输出展示中 JSON 排版的保真度与摘录边界。
 * @implementation 覆盖嵌套结构、大整数、重复键、原样回退和部分摘录。
 * @updated 2026-11-23T00:30:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatToolOutputJson } from './tool-output-format';

const readOutput = 'mcp__atelier__read_tool_output';

test('indents JSON without reserializing its original tokens', () => {
  const source = '{"id":9007199254740993,"id":1e+5,"items":[{},[],{"label":"a,b: [c]"}]}';
  assert.equal(
    formatToolOutputJson(source, 'tool')?.text,
    [
      '{',
      '  "id": 9007199254740993,',
      '  "id": 1e+5,',
      '  "items": [',
      '    {},',
      '    [],',
      '    {',
      '      "label": "a,b: [c]"',
      '    }',
      '  ]',
      '}',
    ].join('\n'),
  );
  assert.equal(
    formatToolOutputJson(JSON.stringify('[true,null]'), 'tool')?.text,
    '[\n  true,\n  null\n]',
  );
});

test('keeps plain text and incomplete top-level JSON in their original format', () => {
  for (const text of ['started\nfinished', '"line\\ntext"', '{"ok":true', 'null', '']) {
    assert.equal(formatToolOutputJson(text, 'tool'), undefined, text);
  }
});

test('separates and reads an excerpt that ends inside a JSON string', () => {
  const excerpt = '{"code":200,"result":"# Title\\n\\nA \\"quote\\" and a literal \\\\n. Partial';
  const raw = JSON.stringify({ toolCallId: 'test-call', offset: 0, total: 12000, excerpt });
  const view = formatToolOutputJson(raw, readOutput);
  assert.match(view?.text ?? '', /"excerpt": "…"/u);
  assert.doesNotMatch(view?.text ?? '', /Title/u);
  assert.equal(
    view?.excerpt,
    '{\n  "code": 200,\n  "result": "# Title\n\nA "quote" and a literal \\n. Partial',
  );
});

test('keeps a later excerpt or plain log excerpt verbatim', () => {
  const excerpt = '{"text":"first\\nsecond"}';
  assert.equal(
    formatToolOutputJson(JSON.stringify({ offset: 200, excerpt }), readOutput)?.excerpt,
    excerpt,
  );
  const plain = 'first\\nsecond\nthird';
  assert.equal(
    formatToolOutputJson(JSON.stringify({ offset: 0, excerpt: plain }), readOutput)?.excerpt,
    plain,
  );
});
