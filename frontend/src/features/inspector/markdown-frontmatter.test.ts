import assert from 'node:assert/strict';
import test from 'node:test';
import { readMarkdownFrontmatter } from '../../components/markdown-frontmatter';

test('Markdown preview separates and formats the opening YAML fields', () => {
  const body = '\r\n# Weather\r\n\r\n---\r\nDetails\r\n';
  const document = '﻿---\r\nname: weather\r\nmetadata: { requires: { bins: [curl] } }\r\n---\r\n';
  assert.deepEqual(readMarkdownFrontmatter(document + body), {
    body,
    fields: [
      { key: 'name', value: 'weather', structured: false },
      { key: 'metadata', value: 'requires:\n  bins:\n    - curl', structured: true },
    ],
  });
  assert.equal(readMarkdownFrontmatter('---\nname: weather\n---')?.body, '');
});

test('Markdown preview preserves horizontal rules and incomplete metadata', () => {
  assert.equal(readMarkdownFrontmatter('---\nRegular heading\n---\n\nBody'), undefined);
  assert.equal(readMarkdownFrontmatter('---\nname: weather\n\n# Weather'), undefined);
  assert.equal(readMarkdownFrontmatter('# Intro\n\n---\nname: weather\n---'), undefined);
});
