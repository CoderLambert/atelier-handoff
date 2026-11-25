/**
 * @file 读取 Git 源码视图中的选区。
 * @implementation 使用 DOM 文本偏移计算原文件行号，在高亮节点之间保持原始缩进。
 * @updated 2026-11-25T17:20:00+08:00
 */
import type { FileQuoteSource } from '@shared/message-quotes';

export type QuoteGitCode = (
  file: FileQuoteSource,
  text: string,
) => 'added' | 'duplicate' | 'limit' | 'tooLong' | 'unavailable';

export function readGitCodeSelection(code: HTMLElement, selection: Selection | null) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  if (!code.contains(range.startContainer) || !code.contains(range.endContainer)) return;
  const text = range.toString();
  if (!text.trim()) return;
  const before = code.ownerDocument.createRange();
  before.selectNodeContents(code);
  before.setEnd(range.startContainer, range.startOffset);
  const startLine = before.toString().split('\n').length;
  const endLine = startLine + text.slice(0, -1).split('\n').length - 1;
  return { text, startLine, endLine };
}
