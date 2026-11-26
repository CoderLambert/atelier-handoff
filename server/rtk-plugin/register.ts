/**
 * @file 在 CLI 插件的执行前事件中对原生 Bash 命令做无副作用权限预检。
 * @implementation 宿主逐次确认后以原样 updatedInput 表示可替换。原命令通过 CLI 预检后，才返回交由 SDK 检查的包装命令。
 * @updated 2026-11-26T02:07:02+08:00
 */
type Input = Readonly<Record<string, unknown>>;
interface Decision {
  allow?: boolean;
  ask?: string;
  deny?: string;
  updatedInput?: Input;
}
// Narrow surface of the locked CLI's classic.PreToolUse and $.tool.check contracts.
type Listener = (
  api: {
    plugin: { root: string };
    fs: { read(path: string): Promise<string> };
    tool: { check(call: { tool: 'Bash'; input: Input }): Promise<{ decision: string }> };
  },
  event: Input & { tool: 'Bash'; command: string; tool_use_id?: string },
  next: (event: Input) => Promise<Decision>,
) => Promise<Decision>;

type On = (name: 'classic.PreToolUse', matcher: { tool: 'Bash' }, listener: Listener) => void;

function plannedCommand(text: string, originalCommand: string): string | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (
      raw &&
      typeof raw === 'object' &&
      'hook' in raw &&
      raw.hook === 'builtin-rtk' &&
      'originalCommand' in raw &&
      raw.originalCommand === originalCommand &&
      'executedCommand' in raw &&
      typeof raw.executedCommand === 'string' &&
      raw.executedCommand
    )
      return raw.executedCommand;
  } catch {
    // An unavailable plan leaves Bash with the original input.
  }
  return undefined;
}

export function register(on: On): void {
  on('classic.PreToolUse', { tool: 'Bash' }, async ($, event, next) => {
    const baseline = await next(event);
    const input = baseline.updatedInput;
    if (!baseline.allow || baseline.ask !== undefined || baseline.deny !== undefined || !input)
      return baseline;
    const { tool, tool_use_id: id, ...original } = event;
    if (
      typeof id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(id) ||
      Object.keys(input).length !== Object.keys(original).length ||
      Object.entries(original).some(([key, value]) => input[key] !== value)
    )
      return baseline;
    const plan = await $.fs.read($.plugin.root + '/plans/' + id + '.json').catch(() => undefined);
    const command = typeof plan === 'string' ? plannedCommand(plan, original.command) : undefined;
    if (!command) return baseline;
    const verdict = await $.tool.check({ tool, input }).catch(() => undefined);
    return verdict?.decision === 'allow'
      ? { ...baseline, updatedInput: { ...input, command } }
      : baseline;
  });
}
