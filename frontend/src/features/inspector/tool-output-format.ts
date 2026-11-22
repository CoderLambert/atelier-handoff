/**
 * @file 为工具输出弹窗准备缩进后的 JSON 和可阅读的摘录。
 * @implementation 保留原始 JSON 标记，仅调整展示空白，并单独排版读取工具回执里的摘录。
 * @updated 2026-11-23T00:30:00+08:00
 */
const jsonToken = /"(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|[{}\[\],:]|[^\s"{}\[\],:]+/gu;
const jsonStart = /^\s*[{[]/u;
const readOutputTool = 'mcp__atelier__read_tool_output';
const readableEscapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function indentJson(text: string, { separateExcerpt = false, readableStrings = false } = {}) {
  const tokens = text.match(jsonToken) ?? [];
  const parts: string[] = [];
  let depth = 0;
  const line = () => '\n' + '  '.repeat(Math.min(depth, 24));

  for (const [index, token] of tokens.entries()) {
    const previous = tokens[index - 1];
    if (token === '}' || token === ']') {
      depth = Math.max(0, depth - 1);
      if (previous !== (token === '}' ? '{' : '[')) parts.push(line());
    } else if (previous === '{' || previous === '[' || previous === ',') {
      parts.push(line());
    }

    if (separateExcerpt && depth === 1 && previous === ':' && tokens[index - 2] === '"excerpt"') {
      parts.push('"…"');
    } else if (readableStrings && token.startsWith('"')) {
      parts.push(
        token.replace(
          /\\([\\nrt"])/gu,
          (escape: string, value: string) => readableEscapes[value] ?? escape,
        ),
      );
    } else {
      parts.push(token);
    }

    if (token === '{' || token === '[') depth++;
    if (token === ':') parts.push(' ');
  }
  return parts.join('');
}

export function formatToolOutputJson(text: string, toolName: string) {
  // Some tools return an object or array already encoded as a JSON string.
  const source = /^\s*"/u.test(text) ? parseJson(text) : text;
  if (typeof source !== 'string' || !jsonStart.test(source)) return undefined;
  const value = parseJson(source);
  if (typeof value !== 'object' || value === null) return undefined;

  if (
    (toolName === readOutputTool || toolName === 'read_tool_output') &&
    'excerpt' in value &&
    typeof value.excerpt === 'string' &&
    value.excerpt.length > 0
  ) {
    const excerpt = value.excerpt;
    // A first receipt slice can end mid-string. Only change its display tokens.
    const readable = 'offset' in value && value.offset === 0 && jsonStart.test(excerpt);
    return {
      text: indentJson(source, { separateExcerpt: true }),
      excerpt: readable ? indentJson(excerpt, { readableStrings: true }) : excerpt,
    };
  }
  return { text: indentJson(source) };
}
