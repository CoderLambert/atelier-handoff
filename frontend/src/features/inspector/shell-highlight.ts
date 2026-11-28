/**
 * @file 为内置 Bash 工具卡片提供轻量同步 Shell 语法分词高亮。
 * @implementation 将命令名、关键字、选项参数、字符串、环境变量、操作符与注释拆分为语义片段，交由主题 CSS 变量着色。
 * @updated 2026-11-28T02:30:00+08:00
 */

export type ShellTokenKind =
  'plain' | 'command' | 'keyword' | 'flag' | 'string' | 'variable' | 'operator' | 'comment';

export interface ShellToken {
  kind: ShellTokenKind;
  value: string;
}

const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'in',
  'do',
  'done',
  'while',
  'until',
  'case',
  'esac',
  'function',
  'select',
  'time',
  'export',
  'local',
  'readonly',
  'return',
  'exit',
  'set',
  'unset',
  'shift',
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function tokenizeShell(source: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const length = source.length;
  let index = 0;
  let expectCommand = true;

  const push = (kind: ShellTokenKind, value: string) => {
    if (!value) return;
    const previous = tokens[tokens.length - 1];
    if (previous && previous.kind === kind) {
      previous.value += value;
    } else {
      tokens.push({ kind, value });
    }
  };

  while (index < length) {
    const ch = source[index]!;

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      let end = index + 1;
      while (
        end < length &&
        (source[end] === ' ' ||
          source[end] === '\t' ||
          source[end] === '\r' ||
          source[end] === '\n')
      ) {
        if (source[end] === '\n') expectCommand = true;
        end++;
      }
      if (ch === '\n') expectCommand = true;
      push('plain', source.slice(index, end));
      index = end;
      continue;
    }

    // Comments (# preceded by start or whitespace)
    if (ch === '#' && (index === 0 || /\s/.test(source[index - 1]!))) {
      let end = index + 1;
      while (end < length && source[end] !== '\n') end++;
      push('comment', source.slice(index, end));
      index = end;
      continue;
    }

    // Single-quoted string
    if (ch === "'") {
      let end = index + 1;
      while (end < length && source[end] !== "'") end++;
      if (end < length) end++;
      push('string', source.slice(index, end));
      expectCommand = false;
      index = end;
      continue;
    }

    // Double-quoted string
    if (ch === '"') {
      let end = index + 1;
      while (end < length && source[end] !== '"') {
        if (source[end] === '\\' && end + 1 < length) end += 2;
        else end++;
      }
      if (end < length) end++;
      push('string', source.slice(index, end));
      expectCommand = false;
      index = end;
      continue;
    }

    // Operators & redirections
    const two = source.slice(index, index + 2);
    if (
      two === '&&' ||
      two === '||' ||
      two === '>>' ||
      two === '<<' ||
      two === '>&' ||
      two === '2>'
    ) {
      let end = index + 2;
      if (two === '2>' && source.slice(index, index + 4) === '2>&1') end = index + 4;
      push('operator', source.slice(index, end));
      if (two === '&&' || two === '||') expectCommand = true;
      index = end;
      continue;
    }

    if (
      ch === '|' ||
      ch === ';' ||
      ch === '&' ||
      ch === '>' ||
      ch === '<' ||
      ch === '(' ||
      ch === ')'
    ) {
      push('operator', ch);
      if (ch === '|' || ch === ';' || ch === '&' || ch === '(') expectCommand = true;
      index++;
      continue;
    }

    // Environment variables ($VAR, ${VAR}, $?, $1)
    if (ch === '$') {
      let end = index + 1;
      if (source[end] === '{') {
        end++;
        while (end < length && source[end] !== '}') end++;
        if (end < length) end++;
      } else if (source[end] === '(') {
        push('operator', '$(');
        expectCommand = true;
        index += 2;
        continue;
      } else {
        while (end < length && /[A-Za-z0-9_?@*#!-]/.test(source[end]!)) end++;
      }
      push('variable', source.slice(index, end));
      expectCommand = false;
      index = end;
      continue;
    }

    // Regular word
    let end = index + 1;
    while (end < length && !/[\s'"|;&><()$]/.test(source[end]!)) {
      if (source[end] === '\\' && end + 1 < length) end += 2;
      else end++;
    }
    const word = source.slice(index, end);

    if (expectCommand && ENV_ASSIGNMENT.test(word)) {
      const eq = word.indexOf('=');
      push('variable', word.slice(0, eq));
      push('operator', '=');
      push('plain', word.slice(eq + 1));
    } else if (SHELL_KEYWORDS.has(word)) {
      push('keyword', word);
      expectCommand =
        word === 'then' || word === 'do' || word === 'else' || word === 'elif' || word === 'time';
    } else if (expectCommand) {
      push('command', word);
      expectCommand = false;
    } else if (word.startsWith('-') && word.length > 1) {
      push('flag', word);
    } else {
      push('plain', word);
    }
    index = end;
  }

  return tokens;
}
