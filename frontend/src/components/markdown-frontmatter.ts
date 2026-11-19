import { isMap, parseDocument } from 'yaml';

export function markdownBody(text: string): string | undefined {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;

  const metadata = parseDocument(match[1]!);
  if (metadata.errors.length || !isMap(metadata.contents)) return undefined;
  return text.slice(match[0].length);
}
