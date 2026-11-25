/**
 * @file 准备用于显示的 Git 补丁和行号。
 * @implementation 复用 jsdiff 解析普通分块并计算行号，保留特殊格式和大补丁的原文。
 * @updated 2026-11-25T13:23:00+08:00
 */
import { parsePatch, type StructuredPatch, type StructuredPatchHunk } from 'diff';

export type GitDiffLine = {
  kind: 'added' | 'removed' | 'context';
  oldLine: number | null;
  newLine: number | null;
  text: string;
  noFinalNewline?: boolean;
};

export type GitDiffHunk = { header: string; lines: GitDiffLine[] };

export type PatchFile =
  | {
      kind: 'text';
      path: string | undefined;
      hunks: GitDiffHunk[];
      metadata: string[];
      added: number;
      removed: number;
    }
  | {
      kind: 'raw';
      path: string | undefined;
      text: string;
      binary: boolean;
    };

/** 单个文件最多渲染行数（超出降为 raw）。已按文件折叠，大文件不再影响后续文件高亮。 */
const maxLinesPerFile = 8000;
/** 单次 patch 渲染行数总上限，防止超大提交（如数十个大文件）一次性塞入 DOM。 */
const maxTotalLines = 80_000;

function filename(patch: StructuredPatch) {
  const name = patch.newFileName === '/dev/null' ? patch.oldFileName : patch.newFileName;
  return patch.isGit ? name?.replace(/^[ab]\//, '') : name;
}

function numberLines(hunk: StructuredPatchHunk) {
  const lines: GitDiffLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const raw of hunk.lines) {
    if (raw.startsWith('\\')) {
      const previous = lines.at(-1);
      if (previous) previous.noFinalNewline = true;
      continue;
    }
    const kind = raw[0] === '+' ? 'added' : raw[0] === '-' ? 'removed' : 'context';
    lines.push({
      kind,
      oldLine: kind === 'added' ? null : oldLine++,
      newLine: kind === 'removed' ? null : newLine++,
      text: raw.slice(1),
    });
  }
  return lines;
}

export function describeGitPatch(patch: string, selectedPath: string | undefined): PatchFile[] {
  const sections = patch.split(/(?<=\n)(?=diff --(?:git|cc|combined) )/u);
  if (sections.length > 120)
    return [{ kind: 'raw', path: selectedPath, text: patch, binary: false }];
  let remainingTotalLines = maxTotalLines;
  return sections.map((text) => {
    const binary = /^(?:Binary files |GIT binary patch)/mu.test(text);
    const fallback: PatchFile = {
      kind: 'raw',
      path: sections.length === 1 ? selectedPath : undefined,
      text,
      binary,
    };
    if (remainingTotalLines <= 0 || text.length > 512_000 || /^diff --(?:cc|combined) /u.test(text))
      return fallback;
    let parsed: StructuredPatch | undefined;
    try {
      const files = parsePatch(text);
      if (files.length !== 1) return fallback;
      [parsed] = files;
    } catch {
      return fallback;
    }
    if (!parsed) return fallback;
    const path = fallback.path ?? filename(parsed);
    const lines = parsed.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    // 单文件超过 maxLinesPerFile 或累计超 maxTotalLines 才降级 raw；
    // 不让大文件吃掉后续文件的渲染配额。
    if (binary || !lines || lines > maxLinesPerFile || lines > remainingTotalLines)
      return { ...fallback, path };
    const headers = [...text.matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gmu)];
    if (headers.length !== parsed.hunks.length) return { ...fallback, path };
    const metadata = text
      .slice(0, headers[0]?.index)
      .split('\n')
      .filter((line) =>
        /^(?:(?:old|new) mode |(?:rename|copy) (?:from|to) |(?:dis)?similarity index )/u.test(line),
      );
    remainingTotalLines -= lines;
    let added = 0;
    let removed = 0;
    const hunks = parsed.hunks.map((hunk, index) => {
      const rows = numberLines(hunk);
      for (const row of rows) {
        if (row.kind === 'added') added++;
        if (row.kind === 'removed') removed++;
      }
      return { header: headers[index]?.[0] ?? '', lines: rows };
    });
    return { kind: 'text', path, metadata, hunks, added, removed };
  });
}
