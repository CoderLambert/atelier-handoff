/**
 * @file 验证审批文件差异对比、补丁解析与行列对齐。
 * @implementation 测试 unified diff 补丁解析、空文件与大文件快照降级，以及双栏行号对齐。
 * @updated 2026-11-23T18:25:00+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffView } from './diff-view';
import { parsePermissionPatch, type PermissionDiff } from './diff-model';

const preview = (values: Partial<PermissionDiff>): PermissionDiff => ({
  diff: '',
  before: null,
  after: null,
  path: 'example.txt',
  kind: 'edit',
  version: 'reviewed-version',
  ...values,
});
const render = (values: Partial<PermissionDiff>) =>
  renderToStaticMarkup(createElement(DiffView, { preview: preview(values) }));

test('approval diff keeps old and new line numbers across context and separate hunks', () => {
  const patch = parsePermissionPatch(
    '--- a/example.txt\n+++ b/example.txt\n@@ -4,2 +4,3 @@\n same\n-old\n+new\n+extra\n@@ -20 +21 @@\n-last\n+replacement\n',
  );
  assert.ok(patch);
  assert.equal(patch.added, 3);
  assert.equal(patch.removed, 2);
  assert.deepEqual(
    patch.hunks[0]?.lines.map(({ kind, oldLine, newLine }) => [kind, oldLine, newLine]),
    [
      ['context', 4, 4],
      ['removed', 5, null],
      ['added', null, 5],
      ['added', null, 6],
    ],
  );
  assert.equal(patch.hunks[1]?.lines[1]?.newLine, 21);
});

test('approval diff handles pure creation and deletion without inventing line zero', () => {
  const create = parsePermissionPatch('@@ -0,0 +1,2 @@\n+first\n+second\n');
  const remove = parsePermissionPatch('@@ -1,2 +0,0 @@\n-first\n-second\n');
  assert.ok(create);
  assert.ok(remove);
  assert.deepEqual(
    create.hunks[0]?.lines.map((line) => [line.oldLine, line.newLine]),
    [
      [null, 1],
      [null, 2],
    ],
  );
  assert.deepEqual(
    remove.hunks[0]?.lines.map((line) => [line.oldLine, line.newLine]),
    [
      [1, null],
      [2, null],
    ],
  );
});

test('incomplete or malformed hunks fall back instead of showing a misleading diff', () => {
  for (const patch of [
    '@@ -1,2 +1 @@\n-old\n+new\n',
    '@@ -1 +1 @@\n-old\n+new\n+unexpected\n',
    '@@ -1 +1 @@\n?unknown\n',
    '@@ -1,2 +1 @@\n-old\n@@ -4 +4 @@\n-next\n+replacement\n',
    '@@ -0,0 +0,0 @@\n\\ No newline at end of file\n',
  ]) {
    assert.equal(parsePermissionPatch(patch), null, patch);
  }
  const html = render({ diff: '@@ -1,2 +1 @@\n-old\n+new\n', before: 'old\nsecond', after: 'new' });
  assert.match(html, /查看原始补丁/);
  assert.match(html, /查看修改前内容/);
  assert.doesNotMatch(html, /<table/);
});

test('BOM, CRLF and missing final newlines remain explicit and HTML is escaped', () => {
  const diff = '@@ -1 +1 @@\n-﻿old\r\n+<script>alert(1)</script>\n\\ No newline at end of file\n';
  const patch = parsePermissionPatch(diff);
  assert.ok(patch);
  assert.equal(patch.hunks[0]?.lines[0]?.text, '﻿old\r');
  assert.equal(patch.hunks[0]?.lines[1]?.noFinalNewline, true);
  const html = render({ diff, before: '﻿old\r\n', after: '<script>alert(1)</script>' });
  assert.match(html, /BOM/);
  assert.match(html, /CRLF/);
  assert.match(html, /文件末尾无换行/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('empty file creation and deletion have distinct explanations', () => {
  assert.match(render({ kind: 'write', before: null, after: '' }), /将新建一个空文件/);
  assert.match(render({ kind: 'delete', before: '', after: null }), /将删除一个空文件/);
  assert.match(render({ before: '', after: '' }), /文件内容没有变化/);
});

test('large diffs expose complete snapshots rather than rendering thousands of table rows', () => {
  const after = Array.from({ length: 2401 }, (_, index) => `line ${index}`).join('\n');
  const diff = `@@ -0,0 +1,2401 @@\n${after
    .split('\n')
    .map((line) => `+${line}`)
    .join('\n')}\n`;
  const html = render({ diff, before: null, after });
  assert.match(html, /查看修改后内容/);
  assert.match(html, /line 2400/);
  assert.doesNotMatch(html, /<table/);
});
