/**
 * @file 将已记录工具参数和回执转换为安全的工具详情展示数据。
 * @implementation 从已记录参数生成工具摘要，并按原生 Bash、受控命令及其他工具的回执结构提取展示字段。
 * @updated 2026-11-22T18:43:11+08:00
 */
import { getTranslator } from '@/i18n';
import type { ToolCall } from '@shared/types';
import { toolOutputFilename } from '@shared/tool-output-download';

type RecordValue = Record<string, unknown>;
export interface ToolTextSection {
  label: string;
  text: string;
}
export interface ToolInputView {
  name: string;
  isCommand: boolean;
  target: string;
  command?: string;
  explanation?: string;
  parameters: string;
  rawInput: boolean;
}
export interface ToolOutputView {
  sections: ToolTextSection[];
  exitCode?: number | null;
  interrupted?: boolean;
  backgroundTaskId?: string;
  truncated: boolean;
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
function parse(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}
function format(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
}
function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function singleLine(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > 180 ? `${line.slice(0, 179)}…` : line;
}
/** Split simple one-line lists at unquoted semicolons for display, retaining every character. */
export function splitCommandForDisplay(command: string): string[] {
  if (!command.includes(';') || /[\r\n`]|<</u.test(command)) return [command];

  const lines: string[] = [];
  let start = 0;
  let parentheses = 0;
  let quote: "'" | '"' | "$'" | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (char === '\\' && quote !== "'") {
      index++;
      continue;
    }
    if (quote) {
      // An expansion within double quotes can have its own quoting rules.
      if (quote === '"' && char === '$' && (next === '(' || next === '{')) return [command];
      if (char === quote || (quote === "$'" && char === "'")) quote = undefined;
      continue;
    }
    if (char === '$' && next === "'") {
      quote = "$'";
      index++;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      parentheses++;
    } else if (char === ')') {
      if (parentheses === 0) return [command];
      parentheses--;
    } else if (char === '#' || char === '{' || char === '[') {
      return [command];
    } else if (char === ';' && parentheses === 0) {
      if (next === ';' || next === '&') return [command];
      let end = index + 1;
      while (command[end] === ' ' || command[end] === '\t') end++;
      if (end < command.length) {
        lines.push(command.slice(start, end));
        start = end;
        index = end - 1;
      }
    }
  }
  return quote || parentheses ? [command] : [...lines, command.slice(start)];
}

function without(value: RecordValue, keys: string[]): RecordValue {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
function exitCode(value: RecordValue, keys: string[]): number | null | undefined {
  for (const key of keys) {
    const code = value[key];
    if (code === null || (typeof code === 'number' && Number.isSafeInteger(code))) return code;
  }
  return undefined;
}

export function toolInputView(tool: ToolCall): ToolInputView {
  const name = tool.name.replace(/^mcp__atelier__/, '');
  const isCommand = name === 'Bash' || name === 'run_command';
  const parsed = parse(tool.inputSummary);
  const input = record(parsed);
  // Older snapshots only have inputSummary; newer records may preserve command separately.
  const recordedCommand = 'command' in tool ? nonempty(tool.command) : undefined;
  const rawInput = tool.inputSummary.trim().length > 0 && parsed === undefined;
  const rawCommand =
    rawInput && !/^[\s]*[\[{]/u.test(tool.inputSummary) ? tool.inputSummary : undefined;
  const command = isCommand
    ? (recordedCommand ??
      nonempty(input?.command) ??
      nonempty(typeof parsed === 'string' ? parsed : rawCommand))
    : undefined;
  const explanation =
    isCommand && input
      ? [nonempty(input.description), nonempty(input.reason)].filter(Boolean).join('\n') ||
        undefined
      : undefined;
  const rest =
    input && command
      ? without(input, [
          'command',
          ...['description', 'reason'].filter((key) => typeof input[key] === 'string'),
        ])
      : undefined;
  const parameters = rest
    ? Object.keys(rest).length
      ? format(rest)
      : ''
    : command && !input && !rawInput
      ? ''
      : parsed === undefined
        ? tool.inputSummary
        : format(parsed);
  const target =
    command ??
    (input
      ? ['file_path', 'path', 'url', 'query', 'pattern', 'skill', 'name', 'description', 'reason']
          .map((key) => nonempty(input[key]))
          .find(Boolean)
      : undefined) ??
    (parsed === undefined ? tool.inputSummary : format(parsed));
  return {
    name,
    isCommand,
    target: singleLine(target),
    command,
    explanation,
    parameters,
    rawInput,
  };
}

/** A stable, searchable single line for tool rows and execution events. */
export function toolCallSummary(tool: ToolCall): string {
  const input = toolInputView(tool);
  return input.target ? `${input.name} · ${input.target}` : input.name;
}

export function toolOutputView(tool: ToolCall): ToolOutputView {
  const t = getTranslator('inspector');
  const { name, isCommand } = toolInputView(tool);
  const parsed = parse(tool.output);
  const result = record(parsed);
  if (
    name === 'Bash' &&
    result &&
    typeof result.stdout === 'string' &&
    typeof result.stderr === 'string'
  ) {
    const extra = without(result, [
      'stdout',
      'stderr',
      ...(typeof result.interrupted === 'boolean' ? ['interrupted'] : []),
      ...['exitCode', 'exit_code', 'code'].filter((key) => exitCode(result, [key]) !== undefined),
      ...(nonempty(result.backgroundTaskId) ? ['backgroundTaskId'] : []),
    ]);
    return {
      sections: [
        { label: 'stdout', text: result.stdout },
        { label: 'stderr', text: result.stderr },
        ...(Object.keys(extra).length
          ? [{ label: t('tool.otherFields'), text: format(extra) }]
          : []),
      ],
      exitCode: exitCode(result, ['exitCode', 'exit_code', 'code']),
      interrupted: typeof result.interrupted === 'boolean' ? result.interrupted : undefined,
      backgroundTaskId: nonempty(result.backgroundTaskId),
      truncated: tool.outputTruncated === true,
    };
  }
  if (
    name === 'run_command' &&
    result &&
    typeof result.output === 'string' &&
    exitCode(result, ['code']) !== undefined
  ) {
    const extra = without(result, [
      'output',
      'code',
      ...(typeof result.truncated === 'boolean' ? ['truncated'] : []),
    ]);
    return {
      sections: [
        { label: t('tool.mergedOutput'), text: result.output },
        ...(Object.keys(extra).length
          ? [{ label: t('tool.otherFields'), text: format(extra) }]
          : []),
      ],
      exitCode: exitCode(result, ['code']),
      truncated: tool.outputTruncated === true || result.truncated === true,
    };
  }
  // The controlled runner records nonzero exits as this exact error text, not a JSON receipt.
  const failureCode =
    name === 'run_command' && tool.status === 'failed'
      ? /^命令退出 (-?\d+|null)\r?\n/u.exec(tool.output)?.[1]
      : undefined;
  const code = failureCode === 'null' ? null : failureCode ? Number(failureCode) : undefined;
  return {
    sections: tool.output.length
      ? [
          {
            label: isCommand ? t('tool.rawReceipt') : t('tool.result'),
            text: parsed === undefined ? tool.output : format(parsed),
          },
        ]
      : [],
    exitCode: typeof code === 'number' && !Number.isSafeInteger(code) ? undefined : code,
    truncated: tool.outputTruncated === true,
  };
}

export interface ToolOutputPresentation {
  title: string;
  actionLabel: string;
  downloadLabel: string;
  downloadName: string;
  rangeLabel: string;
  scope: string | undefined;
}

/** Keep receipt previews distinct from the separately saved Bash log. */
export function toolOutputPresentation(tool: ToolCall): ToolOutputPresentation {
  const t = getTranslator('inspector');
  const log = tool.bashLog;
  const downloadName = toolOutputFilename(log);
  if (!log)
    return {
      title: t('tool.fullOutput'),
      actionLabel: t('tool.viewFullOutput'),
      downloadLabel: t('tool.downloadFullOutput'),
      downloadName,
      rangeLabel: '',
      scope: undefined,
    };
  const saved =
    log.bytes == null ? t('tool.partialLogSaved') : t('tool.savedBytes', { count: log.bytes });
  const source = log.sourceBytes == null ? '' : t('tool.sourceBytes', { count: log.sourceBytes });
  if (log.status === 'complete')
    return {
      title: t('tool.fullBashLog'),
      actionLabel: t('tool.viewFullLog'),
      downloadLabel: t('tool.downloadFullLog'),
      downloadName,
      rangeLabel: t('tool.savedLog'),
      scope:
        log.bytes == null ? t('tool.fullLogSaved') : t('tool.fullLogBytes', { count: log.bytes }),
    };
  if (log.status === 'partial')
    return {
      title: t('tool.savedBashLog'),
      actionLabel: t('tool.viewSavedLog'),
      downloadLabel: t('tool.downloadSaved'),
      downloadName,
      rangeLabel: t('tool.savedLog'),
      scope: t('tool.partialLogScope', { saved, source }),
    };
  return {
    title: t('tool.bashReceipt'),
    actionLabel: t('tool.viewSdkReceipt'),
    downloadLabel: t('tool.downloadSdkReceipt'),
    downloadName,
    rangeLabel: t('tool.sdkReceipt'),
    scope: log.status === 'unavailable' ? t('tool.logUnavailable') : t('tool.receiptOnly'),
  };
}

export function toolDisplayStatus(tool: ToolCall, output: ToolOutputView): string {
  if (tool.status === 'denied' || tool.status === 'canceled') return tool.status;
  if (output.interrupted) return 'interrupted';
  if (output.backgroundTaskId && tool.status === 'succeeded') return 'running';
  if (typeof output.exitCode === 'number' && output.exitCode !== 0) return 'failed';
  return tool.status;
}

export function toolOutputMessage(tool: ToolCall, output: ToolOutputView): string | undefined {
  const t = getTranslator('inspector');
  if (tool.status === 'awaiting_permission') return t('tool.awaitingApproval');
  if (tool.status === 'running') return t('tool.awaitingReceipt');
  if (output.backgroundTaskId && tool.status === 'succeeded') return t('tool.backgroundReceipt');
  if (output.interrupted) return t('tool.commandInterrupted');
  if (output.truncated) return undefined;
  if (
    output.sections.some(
      (section) => section.label !== t('tool.otherFields') && section.text.length > 0,
    )
  )
    return undefined;
  if (tool.status === 'denied') return t('tool.deniedOutput');
  if (tool.status === 'canceled') return t('tool.canceledOutput');
  if (tool.status === 'failed') return t('tool.failedOutput');
  return t('tool.noOutput');
}
