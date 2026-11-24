/**
 * @file 验证 Git 补丁展示数据。
 * @implementation 核对多文件、带引号路径、换行标记、异常和大补丁的表示。
 * @updated 2026-11-24T04:00:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeGitPatch } from './git-diff-model';

const patch = [
  'diff --git "a/\\344\\270\\255\\346\\226\\207.ts" "b/\\344\\270\\255\\346\\226\\207.ts"',
  'index 0123456..abcdef0 100644',
  '--- "a/\\344\\270\\255\\346\\226\\207.ts"',
  '+++ "b/\\344\\270\\255\\346\\226\\207.ts"',
  '@@ -8,2 +9,3 @@ function test() {',
  ' const stable = true;',
  '-const old = 1;',
  '\\ No newline at end of file',
  '+const next = 2;',
  '+export { next };',
  '\\ No newline at end of file',
  '',
].join('\n');
const binary = 'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n';
const merged = 'diff --cc conflict.ts\n@@@ -1,1 -1,1 +1,1 @@@\n++export {};\n';

test('shows Git paths, independent old and new line numbers and newline markers', () => {
  const [file] = describeGitPatch(patch, undefined);
  assert.ok(file?.kind === 'text');
  const [hunk] = file.hunks;
  assert.equal(file.path, '中文.ts');
  assert.deepEqual([file.added, file.removed], [2, 1]);
  assert.ok(hunk);
  assert.deepEqual(hunk.lines, [
    { kind: 'context', oldLine: 8, newLine: 9, text: 'const stable = true;' },
    { kind: 'removed', oldLine: 9, newLine: null, text: 'const old = 1;', noFinalNewline: true },
    { kind: 'added', oldLine: null, newLine: 10, text: 'const next = 2;' },
    { kind: 'added', oldLine: null, newLine: 11, text: 'export { next };', noFinalNewline: true },
  ]);
});

test('preserves raw sections alongside a structured file when the commit mixes formats', () => {
  const [text, image, conflict] = describeGitPatch(patch + binary + merged, undefined);
  assert.equal(text?.kind, 'text');
  assert.deepEqual(image, { kind: 'raw', path: 'logo.png', text: binary, binary: true });
  assert.deepEqual(conflict, { kind: 'raw', path: undefined, text: merged, binary: false });
});

test('keeps the requested path and source text for untracked and oversized patches', () => {
  const trackedShape = '--- /dev/null\n+++ b/notes.ts\n@@ -0,0 +1 @@\n+const x = 1;\n';
  const [file] = describeGitPatch(trackedShape, 'b/notes.ts');
  assert.equal(file?.path, 'b/notes.ts');
  const large = '--- /dev/null\n+++ bulk.ts\n@@ -0,0 +1,2500 @@\n' + '+text\n'.repeat(2500);
  assert.deepEqual(describeGitPatch(large, 'bulk.ts'), [
    { kind: 'raw', path: 'bulk.ts', text: large, binary: false },
  ]);
});
