import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownBody } from '../../components/markdown-frontmatter';

test('Markdown preview skips only the opening YAML metadata block', () => {
  const body = '\r\n# Weather\r\n\r\n---\r\nDetails\r\n';
  const document = '﻿---\r\nname: weather\r\nmetadata: { emoji: "☀️" }\r\n---\r\n';
  assert.equal(markdownBody(document + body), body);
  assert.equal(markdownBody('---\nname: weather\n---'), '');
});

test('Markdown preview preserves horizontal rules and incomplete metadata', () => {
  assert.equal(markdownBody('---\nRegular heading\n---\n\nBody'), undefined);
  assert.equal(markdownBody('---\nname: weather\n\n# Weather'), undefined);
  assert.equal(markdownBody('# Intro\n\n---\nname: weather\n---'), undefined);
});
