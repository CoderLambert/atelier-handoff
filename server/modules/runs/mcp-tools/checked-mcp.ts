/**
 * @file 执行经过授权复核的绑定及外部 MCP 调用。
 * @implementation 统一参数上限、审批及派发前复核，保持两种来源的审批显示、取消及外部调用事件约定。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { AppError } from '../../../../shared/errors.js';
import type { callMcp } from '../../../extension-mcp.js';
import type { EnabledMcp } from '../../../extensions.js';
import type { RunMcpToolHost } from './index.js';

export interface CheckedMcpHost extends Pick<
  RunMcpToolHost,
  | 'projectId'
  | 'workingDirectory'
  | 'approve'
  | 'toolSignal'
  | 'verifyDispatch'
  | 'event'
  | 'mcpSessions'
> {
  run: Pick<RunMcpToolHost['run'], 'mode'>;
  dispatchMcp: typeof callMcp;
  publishScreenshot?: (data: string) => Promise<string>;
}

interface CheckedMcpCall {
  source: { kind: 'binding' } | { kind: 'external'; shared: boolean };
  server: EnabledMcp;
  name: string;
  access: EnabledMcp['allowedTools'][number]['access'];
  args: Record<string, unknown>;
  toolCallId: string;
  recheck(): void;
}

export async function invokeCheckedMcp(
  host: CheckedMcpHost,
  call: CheckedMcpCall,
): Promise<string> {
  const { source, server, name, access, args, toolCallId, recheck } = call;
  const { toolSignal, verifyDispatch, approve, event } = host;
  const external = source.kind === 'external';
  // Skill bindings resolve live grants before encoding arguments. External tools check size first.
  if (!external) recheck();
  const encoded = JSON.stringify(args);
  if (Buffer.byteLength(encoded) > 64 * 1024)
    throw new AppError('MCP_ARGUMENTS_TOO_LARGE', 'MCP 工具参数过大。', 413);
  if (external) recheck();

  const needsApproval = access === 'approval' || (external && source.shared);
  if (needsApproval) {
    if (external && host.run.mode !== 'edit')
      throw new AppError('MCP_TOOL_NOT_ALLOWED', '此工具需要受控修改模式。', 403);
    await approve(
      {
        toolCallId,
        kind: 'mcp',
        command: `${server.name}/${name}\n${external ? JSON.stringify(args, null, 2) : encoded}`,
        reason: external
          ? `向 MCP 服务 ${server.name} 发送参数并执行 ${name}。`
          : `向 ${server.name} 发送参数并执行 ${name}。`,
        ...(external ? { requireManual: source.shared } : {}),
      },
      toolSignal(),
    );
  }
  if (!external || needsApproval) recheck();

  const dispatch = () =>
    host.dispatchMcp(
      server,
      host.workingDirectory,
      name,
      args,
      AbortSignal.any([toolSignal(), AbortSignal.timeout(45_000)]),
      async () => {
        await verifyDispatch();
        recheck();
      },
      host.mcpSessions,
      host.publishScreenshot,
      external ? host.projectId : undefined,
    );
  if (!external) return dispatch();

  const identity = { server: server.name, tool: name, toolCallId };
  event('mcp.call_started', identity);
  try {
    const result = await dispatch();
    toolSignal().throwIfAborted();
    event('mcp.call_finished', { ...identity, status: 'succeeded' });
    return result;
  } catch (error) {
    const code =
      error instanceof AppError ? error.code : toolSignal().aborted ? 'RUN_STOPPED' : 'MCP_TIMEOUT';
    event('mcp.call_finished', {
      ...identity,
      status: toolSignal().aborted ? 'canceled' : 'failed',
      code,
    });
    throw error;
  }
}
