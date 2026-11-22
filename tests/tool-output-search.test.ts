/**
 * @file 验证完整工具日志搜索的原文坐标、有界上下文和无遗漏续读。
 * @implementation 以跨分页、CRLF、UTF-16、空行和超长日志夹具核对命中位置、行去重、游标及回执预算。
 * @updated 2026-11-22T20:53:59+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { searchToolOutput, type ToolOutputSearchResult } from '../server/tool-output-search.js';

function assertOriginalCoordinates(
  text: string,
  query: string,
  result: ToolOutputSearchResult,
): void {
  assert.equal(result.total, text.length);
  assert.ok(result.matches.length <= 4);
  assert.ok(result.matches.reduce((sum, match) => sum + match.excerpt.length, 0) <= 2000);
  for (const match of result.matches) {
    assert.equal(text.slice(match.offset, match.offset + match.matchLength), query);
    assert.equal(match.matchLength, query.length);
    assert.ok(match.offset >= result.offset);
    assert.ok(match.excerpt.length <= 500);
    assert.equal(
      text.slice(match.excerptOffset, match.excerptOffset + match.excerpt.length),
      match.excerpt,
    );
    assert.ok(match.offset >= match.excerptOffset);
    assert.ok(match.offset < match.excerptOffset + match.excerpt.length);
  }
}

test('searches literal text case-sensitively and keeps only the first hit per line', () => {
  const text = 'header\na.b a.b\naXb\nA.B\na.b\n';
  const result = searchToolOutput(text, 'a.b');
  assert.deepEqual(
    result.matches.map(({ line, column, offset }) => ({ line, column, offset })),
    [
      { line: 2, column: 1, offset: 7 },
      { line: 5, column: 1, offset: 23 },
    ],
  );
  assert.equal(result.nextOffset, null);
  assertOriginalCoordinates(text, 'a.b', result);
  assert.equal(searchToolOutput('x.*+?[](){}^$|\\y', '.*+?[](){}^$|\\').matches[0]?.offset, 1);
});

test('returns two context lines on each side without exceeding the requested context', () => {
  const text = 'outside before\nbefore 2\nbefore 1\nneedle\nafter 1\nafter 2\noutside after';
  const result = searchToolOutput(text, 'needle');
  assert.equal(result.matches[0]?.excerpt, 'before 2\nbefore 1\nneedle\nafter 1\nafter 2');
  assert.equal(result.matches[0]?.excerptOffset, text.indexOf('before 2'));
  assert.equal(result.matches[0]?.line, 4);
  assert.equal(result.matches[0]?.truncatedStart, false);
  assert.equal(result.matches[0]?.truncatedEnd, false);
  assertOriginalCoordinates(text, 'needle', result);
});

test('finds hits across original read-page boundaries', () => {
  const text = `before\n${'x'.repeat(1991)}boundary\nnext`;
  const query = 'boundary';
  const result = searchToolOutput(text, query);
  assert.ok(!text.slice(0, 2000).includes(query));
  assert.ok(!text.slice(2000, 4000).includes(query));
  assert.equal(result.matches[0]?.offset, 1998);
  assert.equal(result.matches[0]?.line, 2);
  assert.ok(result.matches[0]?.excerpt.includes(query));
  assertOriginalCoordinates(text, query, result);
});

test('crops a huge single line around a deep hit and preserves its log pagination offset', () => {
  const text = `prefix\n${'x'.repeat(1_000_000)}needle${'y'.repeat(1_000_000)}\nsuffix`;
  const result = searchToolOutput(text, 'needle');
  const match = result.matches[0];
  assert.ok(match);
  assert.equal(match.offset, 1_000_007);
  assert.equal(match.line, 2);
  assert.equal(match.column, 1_000_001);
  assert.ok(match.excerpt.includes('needle'));
  assert.equal(match.excerpt.length, 500);
  assert.equal(match.truncatedStart, true);
  assert.equal(match.truncatedEnd, true);
  assert.ok(text.slice(match.offset, match.offset + 2000).startsWith('needle'));
  assertOriginalCoordinates(text, 'needle', result);
});

test('finds hits at both ends of long lines without clipping a short query', () => {
  for (const text of [`needle${'x'.repeat(10000)}`, `${'x'.repeat(10000)}needle`]) {
    const result = searchToolOutput(text, 'needle');
    assert.ok(result.matches[0]?.excerpt.includes('needle'));
    assert.equal(result.nextOffset, null);
    assertOriginalCoordinates(text, 'needle', result);
  }
});

test('limits four huge matching lines to 2000 excerpt units and points at the fifth hit', () => {
  const text = Array.from({ length: 5 }, (_, index) => `${'x'.repeat(3000)}hit ${index}`).join(
    '\n',
  );
  const first = searchToolOutput(text, 'hit');
  assert.equal(first.matches.length, 4);
  assert.equal(
    first.matches.reduce((sum, match) => sum + match.excerpt.length, 0),
    2000,
  );
  assert.equal(first.nextOffset, text.lastIndexOf('hit'));
  assertOriginalCoordinates(text, 'hit', first);
  assert.ok(first.nextOffset !== null);
  const second = searchToolOutput(text, 'hit', first.nextOffset);
  assert.equal(second.matches.length, 1);
  assert.equal(second.matches[0]?.line, 5);
  assert.equal(second.nextOffset, null);
  assertOriginalCoordinates(text, 'hit', second);
});

test('continuation returns every subsequent matching line exactly once despite context overlap', () => {
  const text = Array.from({ length: 11 }, (_, index) => `line ${index}: hit then hit`).join('\r\n');
  const offsets: number[] = [];
  const lines: number[] = [];
  let cursor: number | null = 0;
  let pages = 0;
  while (cursor !== null) {
    assert.ok(pages++ < 4, 'continuation must make progress');
    const result = searchToolOutput(text, 'hit', cursor);
    assertOriginalCoordinates(text, 'hit', result);
    offsets.push(...result.matches.map((match) => match.offset));
    lines.push(...result.matches.map((match) => match.line));
    if (result.nextOffset !== null) {
      assert.ok(result.nextOffset > (result.matches.at(-1)?.offset ?? cursor));
      assert.equal(text.slice(result.nextOffset, result.nextOffset + 3), 'hit');
    }
    cursor = result.nextOffset;
  }
  assert.equal(pages, 3);
  assert.deepEqual(
    lines,
    Array.from({ length: 11 }, (_, index) => index + 1),
  );
  assert.equal(new Set(offsets).size, 11);
  assert.deepEqual(
    offsets,
    [...text.matchAll(/hit then hit/g)].map((match) => match.index),
  );
});

test('an inclusive offset can select a later occurrence on its starting line', () => {
  const text = 'hit and hit\nnext hit\nlast';
  assert.equal(searchToolOutput(text, 'hit', 0).matches[0]?.offset, 0);
  assert.equal(searchToolOutput(text, 'hit', 1).matches[0]?.offset, 8);
  const exact = searchToolOutput(text, 'hit', 8);
  assert.equal(exact.offset, 8);
  assert.deepEqual(
    exact.matches.map((match) => match.offset),
    [8, 17],
  );
  assert.equal(exact.matches[0]?.column, 9);
  assert.equal(exact.nextOffset, null);
  assertOriginalCoordinates(text, 'hit', exact);
});

test('four matching lines without a fifth return an exhausted cursor even with trailing content', () => {
  for (const text of ['hit\nhit\nhit\nhit', 'hit\nhit\nhit\nhit hit\nquiet\n']) {
    const result = searchToolOutput(text, 'hit');
    assert.equal(result.matches.length, 4);
    assert.equal(result.nextOffset, null);
    assertOriginalCoordinates(text, 'hit', result);
  }
});

test('no match, empty text, empty queries and offsets at or past EOF are exhausted', () => {
  for (const [text, query, offset] of [
    ['abc', 'missing', 0],
    ['abc', 'ABC', 0],
    ['', 'x', 0],
    ['abc', '', 0],
    ['abc', 'a', 3],
    ['abc', 'a', 99],
    ['hit\nquiet', 'hit', 1],
  ] as const) {
    assert.deepEqual(searchToolOutput(text, query, offset), {
      offset,
      total: text.length,
      matches: [],
      nextOffset: null,
    });
  }
  assert.equal(searchToolOutput('a b', ' ').matches[0]?.offset, 1);
});

test('CRLF preserves original offsets and blank context while counting one physical line', () => {
  const text = 'outside\r\n\r\n😀before\r\nneedle\r\n\r\nafter\r\noutside';
  const result = searchToolOutput(text, 'needle');
  const match = result.matches[0];
  assert.ok(match);
  assert.equal(match.offset, text.indexOf('needle'));
  assert.equal(match.line, 4);
  assert.equal(match.column, 1);
  assert.equal(match.excerpt, '\r\n😀before\r\nneedle\r\n\r\nafter');
  assertOriginalCoordinates(text, 'needle', result);
});

test('leading and trailing empty lines stay in the bounded context', () => {
  for (const text of ['\nneedle\n', '\n\nneedle\n\n']) {
    const result = searchToolOutput(text, 'needle');
    assert.equal(result.matches[0]?.excerpt, text);
    assert.equal(result.matches[0]?.excerptOffset, 0);
    assert.equal(result.matches[0]?.offset, text.indexOf('needle'));
    assertOriginalCoordinates(text, 'needle', result);
  }
  assert.equal(searchToolOutput('a\rb needle', 'needle').matches[0]?.line, 1);
});

test('UTF-16 offsets and columns differ from Unicode code-point counts and remain directly readable', () => {
  const text = '😀header\r\n\r\n🧪x needle 🧪\r\nneedle';
  const result = searchToolOutput(text, 'needle');
  assert.equal(result.matches[0]?.line, 3);
  assert.equal(result.matches[0]?.column, 5);
  assert.equal(result.matches[0]?.offset, text.indexOf('needle'));
  assert.notEqual(text.indexOf('needle'), [...text.slice(0, text.indexOf('needle'))].length);
  assertOriginalCoordinates(text, 'needle', result);
  const emoji = searchToolOutput(text, '🧪');
  assert.equal(emoji.matches.length, 1);
  assert.equal(emoji.matches[0]?.matchLength, 2);
  assertOriginalCoordinates(text, '🧪', emoji);
});

test('cropping keeps valid surrogate pairs intact at the snippet edges', () => {
  const text = `${'😀'.repeat(1000)}needle${'😀'.repeat(1000)}`;
  const result = searchToolOutput(text, 'needle');
  const excerpt = result.matches[0]?.excerpt;
  assert.ok(excerpt);
  assert.doesNotMatch(excerpt, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
  assert.ok(excerpt.includes('needle'));
  assertOriginalCoordinates(text, 'needle', result);
});

test('a query longer than the excerpt budget retains the full match length and bounded output', () => {
  const query = 'q'.repeat(3000);
  const text = `before\n${'x'.repeat(3000)}${query}${'x'.repeat(3000)}\nafter`;
  const result = searchToolOutput(text, query);
  const match = result.matches[0];
  assert.ok(match);
  assert.equal(match.matchLength, 3000);
  assert.equal(match.excerpt, 'q'.repeat(500));
  assert.equal(match.excerptOffset, match.offset);
  assert.equal(match.truncatedEnd, true);
  assertOriginalCoordinates(text, query, result);
});

test('dense matches on a huge single line do not allocate one result per occurrence', () => {
  const text = `${'hit '.repeat(500_000)}\nhit`;
  const result = searchToolOutput(text, 'hit');
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0]?.offset, 0);
  assert.equal(result.matches[1]?.offset, text.lastIndexOf('hit'));
  assert.equal(result.matches[1]?.line, 2);
  assert.equal(result.nextOffset, null);
  assertOriginalCoordinates(text, 'hit', result);
});

test('millions of empty lines preserve line numbers without splitting the entire log', () => {
  const text = `${'\n'.repeat(1_000_000)}needle\nneedle`;
  const result = searchToolOutput(text, 'needle');
  assert.deepEqual(
    result.matches.map((match) => match.line),
    [1_000_001, 1_000_002],
  );
  assert.equal(result.matches[0]?.offset, 1_000_000);
  assertOriginalCoordinates(text, 'needle', result);
});

test('rejects multiline queries and invalid UTF-16 offsets', () => {
  for (const query of ['\n', '\r', 'a\nb', 'a\r\nb'])
    assert.throws(() => searchToolOutput('a\nb', query), RangeError);
  for (const offset of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => searchToolOutput('hit', 'hit', offset), RangeError);
});
