/**
 * @file 为模型生成有界的长工具回执摘录和原文读取指针。
 * @implementation 摘录支持的日志和搜索回执，保留 SDK 的原生文件读取范围，按会话、执行者和已发放的指针判定原文读取权限。
 * @updated 2026-11-22T20:41:54+08:00
 */
import type { ToolCall } from '../shared/types.js';

export const inlineOutputLimit = 6000;
export const readOutputName = 'mcp__atelier__read_tool_output';
const diagnostics =
  /\b(?:errors?|fail(?:ed|ures?)?|exceptions?|panic|fatal|warning|assertion|traceback|timed?\s*out|pass(?:ed|es)?|tests?|suites?|skipped)\b|(?:错误|失败|通过|警告)/iu;

function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}

function logExcerpt(text: string): string {
  const important: string[] = [];
  const prefix = text.slice(0, 360);
  const suffix = text.slice(-480);
  let start = 0;
  // Bound memory even for a huge single line or a log with a million identical diagnostics.
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    const line = text.slice(start, Math.min(end < 0 ? text.length : end, start + 320)).trim();
    if (diagnostics.test(line) && !important.includes(line)) {
      important.push(line);
      if (important.length > 4) important.splice(1, 1);
    }
    if (end < 0) break;
    start = end + 1;
  }
  const selected = important.filter((line) => !prefix.includes(line) && !suffix.includes(line));
  return [prefix, ...selected.map((line) => `[诊断行] ${excerpt(line, 180)}`), suffix]
    .filter(Boolean)
    .join('\n[…]\n');
}

export function outputPointer(id: string, length: number): string {
  return `原始回执共 ${length} 个 UTF-16 码元。已知关键词时，调用 ${readOutputName} ${JSON.stringify({ toolCallId: id, query: '关键词' })} 定位命中。按页读取原回执可传 offset、limit，后续页使用 nextOffset。`;
}

export function bashLogNotice(id: string, log: NonNullable<ToolCall['bashLog']>): string {
  const scope =
    log.status === 'complete'
      ? `已保存完整命令日志（${log.bytes} 字节）。`
      : log.status === 'partial'
        ? `已保存命令日志前 ${log.bytes} 字节。`
        : log.status === 'unavailable'
          ? '日志文件未能保存，可检索 SDK 回执中的输出。'
          : '可检索 SDK 错误回执，其内容可能只是部分命令输出。';
  return `${scope} ${readOutputName} 使用 toolCallId=${JSON.stringify(id)}。传 query 定位关键词；传 view="log" 和 offset 在同一文本内读页。`;
}

/** The caller first persists `raw` verbatim. `sample` may be the receipt's human-readable streams. */
export function modelOutputSummary(
  id: string,
  raw: string,
  state: string,
  sample = raw,
): string | undefined {
  if (raw.length <= inlineOutputLimit) return;
  return `[工具输出摘要 · ${state}]\n${outputPointer(id, raw.length)}\n摘录\n${sample.length <= 1500 ? sample : logExcerpt(sample)}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type OutputOwner = Pick<ToolCall, 'id' | 'sessionId' | 'runId' | 'subagentId'>;

export function canReadToolOutput(
  native: boolean,
  reader: OutputOwner,
  item: OutputOwner,
  issued: ReadonlySet<string>,
): boolean {
  if (reader.sessionId !== item.sessionId) return false;
  if (native && reader.subagentId === undefined) return true;
  return (
    reader.runId === item.runId && reader.subagentId === item.subagentId && issued.has(item.id)
  );
}

export function customOutputSummary(name: string, id: string, result: unknown, raw: string) {
  if (raw.length <= inlineOutputLimit || name === readOutputName) return;
  const receipt = record(result);
  if (name === 'mcp__atelier__run_command' && receipt && typeof receipt.output === 'string') {
    const state = typeof receipt.code === 'number' ? `命令退出 ${receipt.code}` : '命令返回';
    return modelOutputSummary(
      id,
      raw,
      receipt.truncated ? `${state} · 执行器已截断` : state,
      receipt.output,
    );
  }
  return modelOutputSummary(id, raw, '完成');
}

export type NativeOutputReplacement = { value: unknown; context?: string };
/** Keep operational metadata, file paths and background job IDs in their original SDK fields. */
export function nativeOutputReplacement(
  name: string,
  id: string,
  data: unknown,
  raw: string,
): NativeOutputReplacement | undefined {
  // Let the SDK keep control of exact file content and Read line ranges.
  if (name === 'Read' || raw.length <= inlineOutputLimit) return;
  const result = record(data);
  if (!result) return;
  const context = outputPointer(id, raw.length);
  if (
    name === 'Bash' &&
    typeof result.stdout === 'string' &&
    typeof result.stderr === 'string' &&
    typeof result.interrupted === 'boolean' &&
    !result.isImage &&
    !result.structuredContent
  ) {
    const { stdout, stderr, ...metadata } = result;
    if (!stdout && !stderr) return;
    const state = result.interrupted ? '中断' : result.backgroundTaskId ? '后台运行中' : '命令返回';
    const sample = [stdout && `stdout\n${stdout}`, stderr && `stderr\n${stderr}`]
      .filter(Boolean)
      .join('\n');
    return {
      value: { ...metadata, stdout: modelOutputSummary(id, raw, state, sample), stderr: '' },
    };
  }
  if (
    name === 'WebFetch' &&
    typeof result.result === 'string' &&
    result.result.length > inlineOutputLimit
  ) {
    return { value: { ...result, result: modelOutputSummary(id, raw, '网页回执', result.result) } };
  }
  if (
    (name === 'Grep' || name === 'Glob') &&
    Array.isArray(result.filenames) &&
    result.filenames.every((path) => typeof path === 'string')
  ) {
    const paths: string[] = [];
    let chars = 0;
    for (const path of result.filenames) {
      if (paths.length >= 8 || chars + path.length > 900) break;
      paths.push(path);
      chars += path.length;
    }
    return {
      value: {
        ...result,
        filenames: paths,
        // Grep uses numFiles for the whole search in count/content modes, where filenames may be empty.
        ...(name === 'Glob' ? { numFiles: paths.length, truncated: true } : {}),
        ...(typeof result.content === 'string' && result.content.length > 1100
          ? { content: excerpt(result.content, 1100) }
          : {}),
      },
      context: [
        '搜索结果摘录已截断。',
        typeof result.numLines === 'number' ? `原回执 ${result.numLines} 行。` : '',
        typeof result.numMatches === 'number' ? `匹配 ${result.numMatches} 处。` : '',
        context,
      ]
        .filter(Boolean)
        .join(' '),
    };
  }
  return;
}
