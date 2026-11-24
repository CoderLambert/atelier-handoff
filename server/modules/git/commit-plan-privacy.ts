/**
 * @file 识别 Git 差异及路径中的潜在凭据并定位其来源。
 * @implementation 识别固定密钥格式与疑似硬编码字面值，按冻结差异两侧的坐标定位，供模型披露与本地提交判断使用。
 * @updated 2026-11-24T21:39:03+08:00
 */
import type { MultiCommitCredential } from '../../../shared/git-multi-commit.js';
import type { GitCommitPlanHunk } from './commit-plan-snapshot.js';

type Rule = MultiCommitCredential['rule'];
type Lines = ReadonlyMap<number, Rule>;
type Span = { start: number; end: number; rule: Rule };

const knownFormat =
  /\b(?:sk|gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9+/=]{16,}(?=[ \t\r]*$))*/gimu;
const assignment =
  /(?<![\w$-])([A-Za-z_$][\w$-]*)["'`]?\s*(?::(?!=)|=(?![=>]))[ \t]*(?:\r?\n[ \t]*)?/gu;
const credentialName =
  /(?:^|[_-])(?:password|passwd|pwd|api[_-]?key|client[_-]?secret|secret[_-]?(?:access[_-]?)?key|token|secret|authorization)$/iu;
const sourcePath = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|cs|java|kt|swift|php|cpp|c|h)$/iu;
const quoted =
  /^(?:"(?:[^"\\\r\n]|\\[^\r\n])*"|'(?:[^'\\\r\n]|\\[^\r\n])*'|`(?:[^`\\\r\n]|\\[^\r\n])*`)/u;
const reference = /^[A-Za-z_$][\w$]*(?:(?:\.|\?\.)[A-Za-z_$][\w$]*)*/u;
const template = /^(?:\$\{[\w.-]+\}|\{\{[\w.-]+\}\}|<[\w.-]+>)/u;
// Explicit whole-value placeholders. A provider format never uses this allowlist.
const placeholders = new Set([
  'placeholder',
  'example-token',
  'dummy-token',
  'fake-token',
  'test-token',
  'test-api-key',
  'dummy-secret',
  'your-token-here',
  'your-api-key-here',
]);

function literalLength(rhs: string, source: boolean): number {
  const expansion = template.exec(rhs)?.[0];
  if (expansion && /^[ \t]*(?:[,;}\]\r\n#]|$)/u.test(rhs.slice(expansion.length))) return 0;
  const value = quoted.exec(rhs)?.[0];
  if (value) {
    const content = value.slice(1, -1).trim();
    if (placeholders.has(content.toLowerCase()) || template.exec(content)?.[0] === content)
      return 0;
    return content.length >= 8 ? value.length : 0;
  }
  const headerValue = /^(?:Bearer|Basic)[ \t]+[^\s"',;}]+/iu.exec(rhs)?.[0];
  if (headerValue) return headerValue.length;
  const identifier = reference.exec(rhs)?.[0];
  if (identifier) {
    const rest = rhs.slice(identifier.length);
    if (
      identifier.startsWith('process.env.') ||
      /^[ \t]*\(/u.test(rest) ||
      (source && /^(?:[ \t]*(?:[;,)}\[\r\n]|$)|[ \t]+(?:as|satisfies)\b)/u.test(rest))
    )
      return 0;
  }
  const bare = /^[^\s"',;}()[\]]{8,}/u.exec(rhs)?.[0];
  return bare && !placeholders.has(bare.toLowerCase()) ? bare.length : 0;
}

function* credentialSpans(text: string, path = ''): Generator<Span> {
  for (const match of text.matchAll(knownFormat))
    yield { start: match.index, end: match.index + match[0].length, rule: 'format' };
  for (const match of text.matchAll(assignment)) {
    const name = match[1]?.replace(/([a-z\d])([A-Z])/gu, '$1_$2');
    if (!name || !credentialName.test(name)) continue;
    let offset = match.index + match[0].length;
    const declaration = /\b(?:const|let|var)[ \t]+$/u.test(
      text.slice(Math.max(0, match.index - 16), match.index),
    );
    if (declaration && match[0].trimEnd().endsWith(':')) {
      // A simple typed declaration can still assign a hardcoded credential.
      const annotation = /^[\w$.]+[ \t]*=[ \t]*(?:\r?\n[ \t]*)?/u.exec(text.slice(offset));
      if (annotation) offset += annotation[0].length;
    }
    const source = declaration || sourcePath.test(path);
    const length = literalLength(text.slice(offset), source);
    if (length > 0) yield { start: match.index, end: offset + length, rule: 'literal' };
  }
}

/** Used for file metadata and untrusted model prose, where line provenance is unavailable. */
export function canSendCommitDiff(diff: string): boolean {
  return Boolean(credentialSpans(diff).next().done);
}

/** One scan per frozen text state. Include the key as well as value lines of a multiline finding. */
export function credentialLines(text: string, path: string): Lines {
  const spans = [...credentialSpans(text, path)].sort((a, b) => a.start - b.start);
  const lines = new Map<number, Rule>();
  let line = 1;
  let newline = text.indexOf('\n');
  for (const span of spans) {
    while (newline !== -1 && newline < span.start) {
      newline = text.indexOf('\n', newline + 1);
      line++;
    }
    let lastLine = line;
    for (let end = newline; end !== -1 && end < span.end - 1; end = text.indexOf('\n', end + 1))
      lastLine++;
    for (let row = line; row <= lastLine; row++)
      if (lines.get(row) !== 'format') lines.set(row, span.rule);
  }
  return lines;
}

export function credentialInPath(path: string): MultiCommitCredential | undefined {
  const rule = credentialSpans(path).next().value?.rule;
  return rule ? { rule, location: { kind: 'path' } } : undefined;
}

/** A newly introduced finding takes priority over any removed line or unchanged context. */
export function credentialInHunks(
  hunks: readonly GitCommitPlanHunk[],
  before: Lines,
  after: Lines,
): MultiCommitCredential | undefined {
  let existing: MultiCommitCredential | undefined;
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const row of hunk.lines) {
      const side = row[0];
      if (side === '+') {
        const rule = after.get(newLine);
        if (rule) return { rule, location: { kind: 'addition', line: newLine } };
      } else if (side === '-') {
        const rule = before.get(oldLine);
        if (rule) existing ??= { rule, location: { kind: 'deletion', line: oldLine } };
      } else if (side === ' ') {
        const rule = after.get(newLine) ?? before.get(oldLine);
        if (rule) existing ??= { rule, location: { kind: 'context', line: newLine } };
      } else {
        continue; // jsdiff's no-newline marker has no line coordinate.
      }
      if (side !== '+') oldLine++;
      if (side !== '-') newLine++;
    }
  }
  return existing;
}

/** When one side is binary or a complete text diff is too expensive, fail closed on text. */
export function credentialInWholeChange(
  before: Lines,
  after: Lines,
): MultiCommitCredential | undefined {
  for (const [line, rule] of after) return { rule, location: { kind: 'addition', line } };
  for (const [line, rule] of before) return { rule, location: { kind: 'deletion', line } };
}
