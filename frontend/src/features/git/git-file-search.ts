/**
 * @file 提供 Git 文件阅读器的 Markdown 识别、源码匹配切分与预览 DOM 高亮。
 * @implementation 支持区分大小写的行内匹配计算、与语法高亮 token 对齐的切分，以及预览区文本节点的安全标记与清理。
 * @updated 2026-11-27T23:03:00+08:00
 */

export interface LineMatch {
  lineIndex: number;
  start: number;
  end: number;
  matchIndex: number;
}

export interface HighlightTokenLike {
  content: string;
  htmlStyle?: Record<string, string>;
}

export interface TokenSlice {
  content: string;
  htmlStyle?: Record<string, string>;
  matchIndex?: number;
}

const MARKDOWN_PATH_RE = /\.(?:md|markdown)$/iu;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'BUTTON', 'SVG']);
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, dt, dd, figcaption, caption';

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_PATH_RE.test(path);
}

/**
 * Find non-overlapping occurrences of `query` across `lines`.
 */
export function findLineMatches(
  lines: readonly string[],
  query: string,
  caseSensitive: boolean,
): LineMatch[] {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: LineMatch[] = [];
  let matchIndex = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';
    const haystack = caseSensitive ? line : line.toLowerCase();
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      matches.push({ lineIndex, start: at, end: at + needle.length, matchIndex });
      matchIndex++;
      from = at + needle.length;
    }
  }
  return matches;
}

/**
 * Split syntax-highlighted tokens (or plain line text) at search match boundaries
 * so syntax colors remain intact inside highlighted matches.
 */
export function splitLineTokensWithMatches(
  lineText: string,
  tokens: readonly HighlightTokenLike[] | undefined,
  matches: readonly LineMatch[],
): TokenSlice[] {
  const sourceTokens: readonly HighlightTokenLike[] = tokens?.length
    ? tokens
    : [{ content: lineText }];

  if (!matches.length) {
    return sourceTokens.map((token) => ({
      content: token.content,
      htmlStyle: token.htmlStyle,
    }));
  }

  const slices: TokenSlice[] = [];
  let cursor = 0;
  let matchCursor = 0;

  for (const token of sourceTokens) {
    const tokenStart = cursor;
    const tokenEnd = cursor + token.content.length;
    let localPos = 0;

    while (matchCursor < matches.length) {
      const match = matches[matchCursor]!;
      if (match.end <= tokenStart + localPos) {
        matchCursor++;
        continue;
      }
      if (match.start >= tokenEnd) break;

      const overlapStart = Math.max(tokenStart + localPos, match.start);
      const overlapEnd = Math.min(tokenEnd, match.end);

      if (overlapStart > tokenStart + localPos) {
        slices.push({
          content: token.content.slice(localPos, overlapStart - tokenStart),
          htmlStyle: token.htmlStyle,
        });
      }
      if (overlapEnd > overlapStart) {
        slices.push({
          content: token.content.slice(overlapStart - tokenStart, overlapEnd - tokenStart),
          htmlStyle: token.htmlStyle,
          matchIndex: match.matchIndex,
        });
      }
      localPos = overlapEnd - tokenStart;
      if (match.end <= tokenEnd) {
        matchCursor++;
      } else {
        break;
      }
    }

    if (localPos < token.content.length) {
      slices.push({
        content: token.content.slice(localPos),
        htmlStyle: token.htmlStyle,
      });
    }
    cursor = tokenEnd;
  }

  return slices;
}

export function clearDomMatches(container: HTMLElement): void {
  const marks = container.querySelectorAll('mark[data-git-search-mark]');
  if (!marks.length) return;
  const parents = new Set<Node>();
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parents.add(parent);
    parent.replaceChild(container.ownerDocument.createTextNode(mark.textContent ?? ''), mark);
  }
  for (const parent of parents) {
    parent.normalize();
  }
}

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

interface NodeSlice {
  start: number;
  end: number;
  matchIndex: number;
}

/**
 * Highlight all occurrences of `query` in rendered preview DOM text nodes.
 * Groups adjacent text nodes by their nearest block ancestor so matches
 * spanning inline formatting (e.g. `**bold** text`) are still found.
 */
export function highlightDomMatches(
  container: HTMLElement,
  query: string,
  caseSensitive: boolean,
): number {
  clearDomMatches(container);
  if (!query) return 0;

  const doc = container.ownerDocument;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let current = node.parentElement;
      while (current && current !== container) {
        if (SKIP_TAGS.has(current.tagName)) return NodeFilter.FILTER_REJECT;
        current = current.parentElement;
      }
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  const blocks = new Map<Element, Text[]>();
  let currentNode = walker.nextNode();
  while (currentNode) {
    const textNode = currentNode as Text;
    const block = textNode.parentElement?.closest(BLOCK_SELECTOR) ?? container;
    const list = blocks.get(block);
    if (list) {
      list.push(textNode);
    } else {
      blocks.set(block, [textNode]);
    }
    currentNode = walker.nextNode();
  }

  const needle = caseSensitive ? query : query.toLowerCase();
  let matchIndex = 0;

  for (const textNodes of blocks.values()) {
    const segments: TextSegment[] = [];
    let combined = '';
    for (const node of textNodes) {
      const value = node.nodeValue ?? '';
      const start = combined.length;
      combined += value;
      segments.push({ node, start, end: combined.length });
    }

    const haystack = caseSensitive ? combined : combined.toLowerCase();
    const nodeSlices = new Map<Text, NodeSlice[]>();
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const matchEnd = at + needle.length;
      for (const seg of segments) {
        if (seg.end <= at) continue;
        if (seg.start >= matchEnd) break;
        const localStart = Math.max(0, at - seg.start);
        const localEnd = Math.min(seg.end - seg.start, matchEnd - seg.start);
        if (localEnd > localStart) {
          const list = nodeSlices.get(seg.node);
          const slice: NodeSlice = { start: localStart, end: localEnd, matchIndex };
          if (list) {
            list.push(slice);
          } else {
            nodeSlices.set(seg.node, [slice]);
          }
        }
      }
      matchIndex++;
      from = matchEnd;
    }

    // Wrap slices in reverse offset order within each text node so earlier offsets stay valid.
    for (const [node, slices] of nodeSlices) {
      for (let i = slices.length - 1; i >= 0; i--) {
        const { start, end, matchIndex: idx } = slices[i]!;
        const target = start > 0 ? node.splitText(start) : node;
        if (end - start < target.length) {
          target.splitText(end - start);
        }
        const mark = doc.createElement('mark');
        mark.className = 'git-search-match';
        mark.dataset.gitSearchMark = String(idx);
        target.parentNode?.replaceChild(mark, target);
        mark.appendChild(target);
      }
    }
  }

  return matchIndex;
}

export function setActiveDomMatch(container: HTMLElement, activeIndex: number): HTMLElement | null {
  let firstActive: HTMLElement | null = null;
  const marks = container.querySelectorAll<HTMLElement>('mark[data-git-search-mark]');
  const target = String(activeIndex);
  for (const mark of marks) {
    if (mark.dataset.gitSearchMark === target) {
      mark.dataset.active = 'true';
      firstActive ??= mark;
    } else {
      delete mark.dataset.active;
    }
  }
  return firstActive;
}
