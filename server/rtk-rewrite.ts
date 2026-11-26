/**
 * @file 用随包 RTK 规划本机 Bash 的输出压缩。
 * @implementation 通过隔离的只读匹配器提议改写，在顶层简单命令段中绑定已验证的启动器并保留精确输出。
 * @updated 2026-11-26T02:30:00+08:00
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

interface Segment {
  start: number;
  end: number;
  words: string[];
}

interface RewriteOptions {
  launcher: string;
  scratch: string;
  signal?: AbortSignal;
}

// Accept flat lists only. Quotes and escapes are kept verbatim. Scripts, pipelines
// and redirections get the original Bash behavior, including their intermediate output.
const shellToken =
  /(?<separator>&&|\|\||;|\n)|(?<word>(?:'[^'\0]*'|"(?:[^"\\`$\0]|\\[^\n\r\0])*"|\\[^\n\r\0]|[^ \t\r\n"'\\$`|&;<>{}()\0])+)|[ \t]+/guy;
const shellContextCommands = new Set([
  '.',
  'alias',
  'builtin',
  'case',
  'coproc',
  'declare',
  'do',
  'done',
  'elif',
  'else',
  'enable',
  'esac',
  'eval',
  'exec',
  'export',
  'fi',
  'for',
  'function',
  'hash',
  'if',
  'local',
  'readonly',
  'select',
  'set',
  'shopt',
  'source',
  'then',
  'trap',
  'typeset',
  'unalias',
  'unset',
  'until',
  'while',
]);

function segments(input: string): Segment[] | undefined {
  const result: Segment[] = [];
  let current: Segment | undefined;
  let scanned = 0;
  for (const token of input.matchAll(shellToken)) {
    scanned = token.index + token[0].length;
    if (token.groups?.separator) {
      if (current) result.push(current);
      current = undefined;
      continue;
    }
    const word = token.groups?.word;
    if (!word) continue;
    if (word.startsWith('#')) return undefined;
    if (!current) {
      if (!/^[\w./-]+$/u.test(word) || shellContextCommands.has(word)) return undefined;
      current = { start: token.index, end: scanned, words: [] };
    }
    current.words.push(word);
    current.end = scanned;
  }
  if (scanned !== input.length) return undefined;
  if (current) result.push(current);
  return result;
}

function replaceSegments(
  input: string,
  parts: readonly Segment[],
  changes: readonly (string | undefined)[],
): string {
  const output: string[] = [];
  let cursor = 0;
  for (const [index, segment] of parts.entries()) {
    const change = changes[index];
    if (change === undefined) continue;
    output.push(input.slice(cursor, segment.start), change);
    cursor = segment.end;
  }
  output.push(input.slice(cursor));
  return output.join('');
}

const exactOutputFlag =
  /^(?:--(?:json|porcelain|format|message-format|output|output-format|reporter|template|jq|raw|csv|xml|yaml|zero|null|print0|vimgrep|skip-env)(?:=|$)|-(?:json|print0|0|z)$|-o(?:$|=|json|yaml|name|wide|go-template|custom-columns))/u;
const gitLogDetailFlag =
  /^--(?:left-right|graph|merges|first-parent|ancestry-path|boundary|cherry|cherry-mark|cherry-pick|all|full-history)(?:=|$)/u;

function preserveOutput({ words }: Segment): boolean {
  const [command, ...args] = words.map((word) => word.replace(/['"\\]/gu, ''));
  const program = command?.split('/').at(-1);
  if (program === 'rtk') return true;
  if (args.some((arg) => exactOutputFlag.test(arg))) return true;
  if (program === 'cat')
    return args.some((arg) => /^(?:--number(?:-nonblank)?|-[nb]+)$/u.test(arg));
  if (program === 'tree') return args.some((arg) => /^-[a-zA-Z]*[JX][a-zA-Z]*$/u.test(arg));
  if (program !== 'git') return false;
  if (args.includes('log') && args.some((arg) => arg.includes('..') || gitLogDetailFlag.test(arg)))
    return true;
  return (
    args.includes('branch') && args.some((arg) => /^-(?:[arv]+|-all|-remotes|-verbose)$/u.test(arg))
  );
}

export async function planBuiltinRtkCommand(
  original: string,
  { launcher, scratch, signal }: RewriteOptions,
): Promise<string | undefined> {
  if (Buffer.byteLength(original) > 32 * 1024) return undefined;
  const parts = segments(original);
  if (!parts?.length) return undefined;
  const preserve = parts.map(preserveOutput);
  if (preserve.every(Boolean)) return undefined;

  // npm's short test alias is documented by RTK, but its 1.2.1 registry recognizes npm run.
  const normalized = parts.map(({ start, end }, index) => {
    const command = original.slice(start, end);
    return preserve[index]
      ? command
      : command.replace(/^npm([ \t]+)test(?=[ \t]|$)/u, 'npm$1run test');
  });
  const input = replaceSegments(original, parts, normalized);
  const response = await execute(launcher, ['hook', 'check', '--', input], {
    // A data directory can sit inside a project. RTK looks upward for Claude rules.
    cwd: '/',
    env: {
      HOME: scratch,
      XDG_CONFIG_HOME: scratch,
      XDG_DATA_HOME: scratch,
      XDG_CACHE_HOME: scratch,
      CLAUDE_CONFIG_DIR: scratch,
      ATELIER_RTK_HOME: scratch,
      LC_ALL: 'C',
    },
    encoding: 'utf8',
    maxBuffer: 128 * 1024,
    timeout: 500,
    signal,
  }).catch(() => undefined);
  if (!response) return undefined;

  const output = response.stdout;
  const suggested = segments(output);
  if (suggested?.length !== parts.length) return undefined;
  const executable = "'" + launcher.replaceAll("'", "'\\''") + "'";
  const rewritten = replaceSegments(
    original,
    parts,
    suggested.map((part, index) => {
      if (
        preserve[index] ||
        part.words[0] !== 'rtk' ||
        !part.words[1] ||
        part.words[1].startsWith('-')
      )
        return undefined;
      const command = normalized[index];
      if (!command) return undefined;
      // A package script may choose a specific linter/test runner. Keep the script itself.
      if (/^npm[ \t]+(?:run|run-script)[ \t]/u.test(command))
        return executable + ' --atelier-exec ' + command;
      const prefix = part.words[1] === 'git' ? executable : executable + ' --atelier-exec';
      return prefix + output.slice(part.start + 'rtk'.length, part.end);
    }),
  );
  return rewritten === original ? undefined : rewritten;
}
