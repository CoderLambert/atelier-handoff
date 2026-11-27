/**
 * @file 验证 Git 文件阅读器的 Markdown 识别与源码搜索切分逻辑。
 * @implementation 覆盖大小写匹配、跨 token 匹配边界切分以及重叠匹配跳过。
 * @updated 2026-11-27T23:03:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findLineMatches,
  isMarkdownPath,
  splitLineTokensWithMatches,
} from './git-file-search';

test('isMarkdownPath detects .md and .markdown extensions case-insensitively', () => {
  assert.equal(isMarkdownPath('AGENTS.md'), true);
  assert.equal(isMarkdownPath('docs/README.MD'), true);
  assert.equal(isMarkdownPath('notes/guide.markdown'), true);
  assert.equal(isMarkdownPath('src/index.ts'), false);
  assert.equal(isMarkdownPath('markdown.txt'), false);
});

test('findLineMatches finds non-overlapping matches and respects case sensitivity', () => {
  const lines = ['Hello World', 'hello aaa world'];
  assert.deepEqual(findLineMatches(lines, 'hello', false), [
    { lineIndex: 0, start: 0, end: 5, matchIndex: 0 },
    { lineIndex: 1, start: 0, end: 5, matchIndex: 1 },
  ]);
  assert.deepEqual(findLineMatches(lines, 'hello', true), [
    { lineIndex: 1, start: 0, end: 5, matchIndex: 0 },
  ]);
  assert.deepEqual(findLineMatches(lines, 'aa', false), [
    { lineIndex: 1, start: 6, end: 8, matchIndex: 0 },
  ]);
  assert.deepEqual(findLineMatches(lines, '', false), []);
});

test('splitLineTokensWithMatches splits across Shiki token boundaries', () => {
  const tokens = [
    { content: 'const ', htmlStyle: { color: '#cf222e' } },
    { content: 'helloWorld', htmlStyle: { color: '#0550ae' } },
    { content: ' = 1;', htmlStyle: { color: '#24292f' } },
  ];
  // Match "loWo" at cols 9..13 inside "helloWorld" (6..16)
  const matches = [{ lineIndex: 0, start: 9, end: 13, matchIndex: 0 }];
  const slices = splitLineTokensWithMatches('const helloWorld = 1;', tokens, matches);
  assert.deepEqual(slices, [
    { content: 'const ', htmlStyle: { color: '#cf222e' } },
    { content: 'hel', htmlStyle: { color: '#0550ae' } },
    { content: 'loWo', htmlStyle: { color: '#0550ae' }, matchIndex: 0 },
    { content: 'rld', htmlStyle: { color: '#0550ae' } },
    { content: ' = 1;', htmlStyle: { color: '#24292f' } },
  ]);

  // Match spanning across two tokens: "t hel" at cols 4..9
  const crossMatches = [{ lineIndex: 0, start: 4, end: 9, matchIndex: 2 }];
  const crossSlices = splitLineTokensWithMatches('const helloWorld = 1;', tokens, crossMatches);
  assert.deepEqual(crossSlices, [
    { content: 'cons', htmlStyle: { color: '#cf222e' } },
    { content: 't ', htmlStyle: { color: '#cf222e' }, matchIndex: 2 },
    { content: 'hel', htmlStyle: { color: '#0550ae' }, matchIndex: 2 },
    { content: 'loWorld', htmlStyle: { color: '#0550ae' } },
    { content: ' = 1;', htmlStyle: { color: '#24292f' } },
  ]);
});
