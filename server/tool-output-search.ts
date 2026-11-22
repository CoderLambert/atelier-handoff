/**
 * @file 在完整可读工具日志中定位字面匹配，返回可分页复用的偏移和有界上下文。
 * @implementation 直接搜索原文、每行取首次命中，以固定大小的行计数块和片段限制内存；游标指向下一条未返回命中。
 * @updated 2026-11-22T20:53:59+08:00
 */
const maxMatches = 4;
const excerptLimit = 500;
const contextLines = 2;
const lineCountChunk = 8192;

export interface ToolOutputSearchMatch {
  /** One-based physical line and UTF-16 column; LF ends a line, including in CRLF. */
  line: number;
  column: number;
  /** Actual match start and full query length in the original readable text, in UTF-16 units. */
  offset: number;
  matchLength: number;
  /** A contiguous original-text slice, with at most two lines before and after the hit. */
  excerpt: string;
  excerptOffset: number;
  /** The character budget removed part of the eligible two-line context or matching line. */
  truncatedStart: boolean;
  truncatedEnd: boolean;
}

export interface ToolOutputSearchResult {
  /** Inclusive search start and total length of the same readable text, in UTF-16 units. */
  offset: number;
  total: number;
  matches: ToolOutputSearchMatch[];
  /** Actual start of the next unreturned matching line's first hit; null means exhausted. */
  nextOffset: number | null;
}

function countNewlines(text: string, start: number, end: number): number {
  let count = 0;
  // Bound temporary strings/arrays even for millions of empty lines; never split the whole log.
  for (let position = start; position < end; position += lineCountChunk) {
    const chunk = text.slice(position, Math.min(end, position + lineCountChunk));
    count += chunk.match(/\n/g)?.length ?? 0;
  }
  return count;
}

function contentEnd(text: string, newline: number): number {
  if (newline < 0) return text.length;
  return newline > 0 && text.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
}

function matchExcerpt(
  text: string,
  offset: number,
  matchLength: number,
  lineStart: number,
  newline: number,
): Pick<ToolOutputSearchMatch, 'excerpt' | 'excerptOffset' | 'truncatedStart' | 'truncatedEnd'> {
  let contextStart = lineStart;
  for (let count = 0; count < contextLines && contextStart > 0; count++) {
    contextStart = contextStart === 1 ? 0 : text.lastIndexOf('\n', contextStart - 2) + 1;
  }
  let contextEnd = contentEnd(text, newline);
  for (let count = 0, next = newline; count < contextLines && next >= 0; count++) {
    next = text.indexOf('\n', next + 1);
    contextEnd = contentEnd(text, next);
  }

  // Reserve space for the hit first. Queries over the budget show their beginning only.
  const before = Math.floor((excerptLimit - Math.min(matchLength, excerptLimit)) / 2);
  let excerptOffset = Math.max(contextStart, Math.min(offset - before, contextEnd - excerptLimit));
  let excerptEnd = Math.min(contextEnd, excerptOffset + excerptLimit);
  // Keep valid surrogate pairs intact at cropped edges, without hiding a literal half-pair hit.
  if (
    excerptOffset < offset &&
    isHighSurrogate(text.charCodeAt(excerptOffset - 1)) &&
    isLowSurrogate(text.charCodeAt(excerptOffset))
  )
    excerptOffset++;
  if (
    (matchLength > excerptLimit || excerptEnd > offset + matchLength) &&
    isHighSurrogate(text.charCodeAt(excerptEnd - 1)) &&
    isLowSurrogate(text.charCodeAt(excerptEnd))
  )
    excerptEnd--;
  return {
    excerpt: text.slice(excerptOffset, excerptEnd),
    excerptOffset,
    truncatedStart: excerptOffset > contextStart,
    truncatedEnd: excerptEnd < contextEnd,
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Case-sensitive literal search over the complete readable log, independent of read-page boundaries.
 * `offset` is an inclusive UTF-16 index into this exact `text`, not serialized storage or an excerpt.
 * Returns at most four matching lines and 2,000 excerpt UTF-16 units in total. Each line contributes
 * only its first hit at/after the supplied offset; remaining hits on that line are intentionally
 * skipped, including when continuing with `nextOffset`. Supply a hit's `offset` to log pagination.
 * Continue the same query/text at `nextOffset` to get subsequent matching lines without duplicates.
 * LF and CRLF each delimit one line; a standalone CR is ordinary text. Excerpts preserve internal
 * line endings and blank lines, but exclude the last context line's terminator. Very long queries
 * may be clipped in the excerpt; `matchLength` always describes the complete original-text match.
 * Empty queries produce no matches. Multiline queries and invalid offsets throw RangeError; the
 * tool boundary should validate those inputs before calling. An offset past EOF is simply exhausted.
 */
export function searchToolOutput(text: string, query: string, offset = 0): ToolOutputSearchResult {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RangeError('offset must be a nonnegative safe UTF-16 integer');
  if (query.includes('\n') || query.includes('\r'))
    throw new RangeError('query must be a single line');
  const matches: ToolOutputSearchMatch[] = [];
  const result: ToolOutputSearchResult = { offset, total: text.length, matches, nextOffset: null };
  if (!query || offset >= text.length) return result;

  let next = text.indexOf(query, offset);
  let line = 1;
  let countedUntil = 0;
  while (next >= 0 && matches.length < maxMatches) {
    line += countNewlines(text, countedUntil, next);
    countedUntil = next;
    const lineStart = text.lastIndexOf('\n', next - 1) + 1;
    const newline = text.indexOf('\n', next);
    matches.push({
      line,
      column: next - lineStart + 1,
      offset: next,
      matchLength: query.length,
      ...matchExcerpt(text, next, query.length, lineStart, newline),
    });
    // Skip the rest of this physical line in one operation, even if it contains millions of hits.
    next = newline < 0 ? -1 : text.indexOf(query, newline + 1);
  }
  result.nextOffset = next < 0 ? null : next;
  return result;
}
