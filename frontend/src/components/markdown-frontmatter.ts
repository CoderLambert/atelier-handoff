import { isCollection, isMap, isScalar, parseDocument, stringify, type Node } from 'yaml';

export function readMarkdownFrontmatter(text: string) {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;

  const yaml = match[1]!;
  const metadata = parseDocument(yaml, { intAsBigInt: true });
  if (metadata.errors.length || !isMap<Node, Node>(metadata.contents)) return undefined;

  function format(node: Node | null): string {
    if (node === null) return 'null';
    if (isScalar(node)) return String(node.value);
    try {
      return stringify(node, { collectionStyle: 'block', verifyAliasOrder: false }).trimEnd();
    } catch {
      return node.range ? yaml.slice(node.range[0], node.range[1]) : '';
    }
  }

  return {
    body: text.slice(match[0].length),
    fields: metadata.contents.items.map(({ key, value }) => ({
      key: format(key),
      value: format(value),
      structured: isCollection(value),
    })),
  };
}
