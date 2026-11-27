/**
 * @file 构造 Claude SDK 的 PreToolUse、PostToolUse 与 PostToolUseFailure 钩子。
 * @implementation 集中校验工具白名单、子代理能力、内置 RTK 改写与输出分页提示，向 AgentRunner 返回标准钩子配置。
 * @updated 2026-11-27T12:52:00-06:00
 */
import { lstat } from 'node:fs/promises';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RtkTrace } from '../../../shared/rtk-trace.js';
import {
  AppError,
  type AgentCapability,
  type Run,
  type Step,
  type ToolCall,
} from '../../../shared/types.js';
import type { FileRecords } from '../../artifacts.js';
import { builtinRtkAvailable, publishBuiltinRtkPlan } from '../../builtin-rtk.js';
import { readProjectText } from '../../files.js';
import type { BashTaskReceipt, NativeBashTasks } from '../../native-bash.js';
import { nativeWorkTools } from '../../native-harness.js';
import { planBuiltinRtkCommand } from '../../rtk-rewrite.js';
import type { RunSkill } from '../../run-skills.js';
import type { Store } from '../../store.js';
import type { SubagentRun } from '../../subagent-run.js';
import {
  bashLogNotice,
  inlineOutputLimit,
  nativeOutputReplacement,
  outputPointer,
} from '../../tool-output-context.js';
import type { LiveTurnCoordinator } from './live-turn-coordinator.js';
import type { RunEnvironment } from './run-environment.js';
import type { RunTranscriptLedger } from './run-transcript-ledger.js';
import type { ToolInvocationGate } from './tool-invocation-gate.js';

export interface RunToolHooksDeps {
  run: Run;
  projectId: string;
  sessionId: string;
  workingDirectory: string;
  native: boolean;
  delegate: boolean;
  sdkSessionId: string;
  signal: AbortSignal;
  toolSignal: () => AbortSignal;
  store: Store;
  files: FileRecords;
  environment: RunEnvironment;
  documentPaths: ReadonlyMap<string, string>;
  candidates: Map<string, RunSkill>;
  skillCalls: Map<string, RunSkill>;
  rtkPlans: Map<string, RtkTrace>;
  recordRtkReceipt: (id: string, input: unknown) => void;
  rtk?: { binary: string; enabled(projectId: string): boolean };
  verifyWorkspace?: (run: Run) => Promise<void>;
  verifyCurrent: () => void;
  verifyDispatch: () => Promise<void>;
  allowed: (capability: AgentCapability) => boolean;
  subagents: SubagentRun;
  bash?: NativeBashTasks;
  turn: LiveTurnCoordinator;
  ledger: RunTranscriptLedger;
  toolGate: ToolInvocationGate;
  permittedMcp: Set<string>;
  exploreTools: string[];
  workerTools: string[];
  pagedOutputIds: Set<string>;
  appToolId: (id: string, agentId?: string) => string;
  createTool: (
    id: string,
    name: string,
    args: unknown,
    subagentId?: string,
    useId?: string,
    sdkActorId?: string,
  ) => ToolCall;
  finishTool: (
    id: string,
    ok: boolean | 'stopped' | 'unknown',
    output: string,
    bashLog?: ToolCall['bashLog'],
  ) => ToolCall | undefined;
  finishWithBashLog: (
    id: string,
    useId: string,
    response: unknown,
    raw: string,
    hookSession: string,
    outcome: true | 'stopped',
  ) => Promise<ToolCall | undefined>;
  finishBashTask: (task: BashTaskReceipt) => Promise<void>;
  feedbackFor: (id: string) => string | undefined;
  cleanError: (error: unknown, maxChars?: number) => string;
}

export function createRunToolHooks(deps: RunToolHooksDeps) {
  const {
    run,
    projectId,
    sessionId,
    workingDirectory,
    native,
    delegate,
    sdkSessionId,
    signal,
    toolSignal,
    store,
    files,
    environment,
    documentPaths,
    candidates,
    skillCalls,
    rtkPlans,
    recordRtkReceipt,
    rtk,
    verifyWorkspace,
    verifyCurrent,
    verifyDispatch,
    allowed,
    subagents,
    bash,
    turn,
    ledger,
    toolGate,
    permittedMcp,
    exploreTools,
    workerTools,
    pagedOutputIds,
    appToolId,
    createTool,
    finishTool,
    finishWithBashLog,
    finishBashTask,
    feedbackFor,
    cleanError,
  } = deps;

  const preTool: HookCallback = async (event) => {
    const decision = (
      permissionDecision: 'allow' | 'deny',
      permissionDecisionReason: string,
      updatedInput?: Record<string, unknown>,
    ) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision,
        permissionDecisionReason,
        updatedInput,
      },
    });
    try {
      signal.throwIfAborted();
      if (event.hook_event_name !== 'PreToolUse') return {};
      if (run.workspacePath) await verifyWorkspace?.(run);
      verifyCurrent();
      const { atelierTicket: _untrustedTicket, ...args } = z
        .record(z.string(), z.unknown())
        .parse(event.tool_input);
      const id = appToolId(event.tool_use_id, event.agent_id);
      const actor = event.agent_id ? subagents.actor(event.agent_id) : undefined;
      if (actor) subagents.ensureBranchSignal(actor.id).throwIfAborted();
      if (
        actor &&
        !(actor.kind === 'explore' ? exploreTools : workerTools).includes(event.tool_name)
      )
        throw new Error('子任务未获此工具权限。');
      if (event.tool_name === 'Agent') {
        if (!delegate || actor) throw new Error('本轮未开放此委派。');
        const request = subagents.reserve(id, event.tool_use_id, args);
        createTool(
          id,
          'Agent',
          { description: request.description, subagent_type: request.subagent_type },
          undefined,
          event.tool_use_id,
        );
        return decision('allow', '允许本轮本地子代理任务。', request);
      }
      if (event.tool_name === 'Read') {
        if (typeof args.file_path !== 'string') throw new Error('缺少文件路径。');
        const attachment = documentPaths.get(args.file_path);
        if (attachment) {
          if (!allowed('attachments')) throw new Error('本轮未开放附件读取。');
          files.attachmentFile(attachment, sessionId);
          const metadata = await lstat(args.file_path);
          if (!metadata.isFile() || metadata.nlink !== 1)
            throw new AppError('ATTACHMENT_UNAVAILABLE', '附件读取视图不可用。', 404);
        } else if (!native) {
          if (!allowed('read')) throw new Error('工具未开放。');
          await readProjectText(workingDirectory, args.file_path);
        }
        signal.throwIfAborted();
      } else if (event.tool_name === 'TodoWrite') {
        if (!allowed('plan')) throw new Error('工具未开放。');
        z.array(
          z
            .object({
              content: z.string().max(1000),
              status: z.enum(['pending', 'in_progress', 'completed']),
            })
            .passthrough(),
        )
          .max(30)
          .parse(args.todos);
      } else if (event.tool_name === 'Skill') {
        const skill = typeof args.skill === 'string' ? candidates.get(args.skill) : undefined;
        if (
          event.agent_id ||
          (!skill &&
            (!native ||
              (typeof args.skill === 'string' &&
                /^(?:host-skills|workspace-skills|atelier-skills):/iu.test(args.skill))))
        )
          throw new Error('该 Skill 不在本轮自动调用名单中。');
        if (skill) skillCalls.set(id, skill);
      } else if (event.tool_name === 'TaskStop') {
        if (!bash?.authorizesStop(args, actor?.id))
          throw new AppError('BASH_CONTROL_UNAVAILABLE', '任务不属于本轮可停止的 Bash 命令。', 409);
      } else if (
        !(native && nativeWorkTools.includes(event.tool_name)) &&
        !permittedMcp.has(event.tool_name)
      )
        throw new Error('工具未开放。');
      createTool(
        id,
        event.tool_name,
        event.tool_name === 'Skill' ? { skill: args.skill } : args,
        actor?.id,
        event.tool_use_id,
        event.agent_id,
      );
      const mountedRtk = environment.rtk;
      let rtkCandidate: Record<string, unknown> | undefined;
      if (
        event.tool_name === 'Bash' &&
        !event.agent_id &&
        event.session_id === sdkSessionId &&
        mountedRtk &&
        rtk?.enabled(projectId) &&
        typeof args.command === 'string' &&
        typeof event.tool_use_id === 'string' &&
        (await builtinRtkAvailable(rtk.binary))
      ) {
        const executedCommand = await planBuiltinRtkCommand(args.command, {
          launcher: mountedRtk.launcher,
          scratch: mountedRtk.path,
          signal: toolSignal(),
        });
        await verifyDispatch();
        if (executedCommand && rtk.enabled(projectId)) {
          const plan: RtkTrace = {
            hook: 'builtin-rtk',
            originalCommand: args.command,
            executedCommand,
          };
          const published = await publishBuiltinRtkPlan(mountedRtk.path, event.tool_use_id, plan);
          verifyCurrent();
          if (published && rtk.enabled(projectId)) {
            rtkPlans.set(id, plan);
            // Leave the original input intact for the CLI plugin's rule check.
            rtkCandidate = args;
          }
        }
      }
      const updatedInput = permittedMcp.has(event.tool_name)
        ? {
            ...args,
            atelierTicket: toolGate.issue(id, event.tool_name, args, actor?.id),
          }
        : rtkCandidate;
      return decision('allow', '受控工具，审批由工作台执行器按本轮设置处理。', updatedInput);
    } catch (error) {
      if (event.hook_event_name === 'PreToolUse' && !signal.aborted) {
        const id = appToolId(event.tool_use_id, event.agent_id);
        if (!event.agent_id) ledger.recordBlockedTool(id, event.tool_name);
        store.event(run.id, sessionId, 'tool.blocked', {
          tool: event.tool_name,
          toolCallId: id,
          code: error instanceof AppError ? error.code : null,
          reason: cleanError(error),
        });
      }
      return decision('deny', cleanError(error));
    }
  };

  const postTool: HookCallback = async (event) => {
    if (event.hook_event_name !== 'PostToolUse') return {};
    if (event.tool_name === 'Agent') {
      if (event.session_id !== sdkSessionId || event.agent_id) return {};
      const id = appToolId(event.tool_use_id, event.agent_id);
      subagents.report(id, event.tool_response);
      turn.onToolBoundary();
      turn.sendInsertion();
      return {};
    }
    if (event.tool_name === 'TodoWrite') {
      const plan = z
        .array(
          z.object({
            content: z.string(),
            status: z.enum(['pending', 'in_progress', 'completed']),
          }),
        )
        .parse((event.tool_input as { todos: unknown }).todos) as Step[];
      store.update('runs', run.id, { plan });
      store.event(run.id, run.sessionId, 'plan.updated', { plan });
    }
    const id = appToolId(event.tool_use_id, event.agent_id);
    let replacement: ReturnType<typeof nativeOutputReplacement>;
    let logNote: string | undefined;
    if (!permittedMcp.has(event.tool_name)) {
      const response = event.tool_response;
      const raw = JSON.stringify(response) ?? '';
      if (event.tool_name === 'Bash' && bash && event.session_id === sdkSessionId) {
        recordRtkReceipt(id, event.tool_input);
        if (!event.agent_id) turn.onToolBoundary();
        const handoff = bash.handedOff(id, response);
        if (handoff) {
          if (handoff.terminal) await finishBashTask(handoff.terminal);
          turn.sendInsertion();
          return {};
        }
      }
      const outcome =
        event.tool_name === 'Bash' &&
        z.object({ interrupted: z.literal(true) }).safeParse(response).success
          ? 'stopped'
          : true;
      const hasSpill =
        event.tool_name === 'Bash' &&
        typeof response === 'object' &&
        response !== null &&
        'persistedOutputPath' in response;
      const saved = hasSpill
        ? await finishWithBashLog(id, event.tool_use_id, response, raw, event.session_id, outcome)
        : finishTool(id, outcome, raw);
      if (saved) {
        replacement = nativeOutputReplacement(event.tool_name, id, response, raw);
        if (saved.bashLog) logNote = bashLogNotice(id, saved.bashLog);
      }
      if (replacement || logNote) pagedOutputIds.add(id);
    }
    turn.sendInsertion();
    const context = [feedbackFor(id), replacement?.context, logNote].filter(Boolean).join('\n');
    if (!replacement && !context) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse' as const,
        ...(replacement ? { updatedToolOutput: replacement.value } : {}),
        ...(context ? { additionalContext: context } : {}),
      },
    };
  };

  const postToolFailure: HookCallback = async (event) => {
    if (event.hook_event_name === 'PostToolUseFailure') {
      const id = appToolId(event.tool_use_id, event.agent_id);
      const error = cleanError(event.error, Infinity);
      if (
        event.tool_name === 'Bash' &&
        event.session_id === sdkSessionId &&
        /^Exit code [1-9]\d*\b/u.test(error)
      )
        recordRtkReceipt(id, event.tool_input);
      if (event.tool_name === 'Bash' && bash?.deferFailureDuringStop(id, error)) return {};
      if (event.tool_name === 'Agent') {
        subagents.finish(
          id,
          signal.aborted || event.is_interrupt === true ? 'stopped' : 'failed',
          error,
        );
        turn.sendInsertion();
        return {};
      }
      const saved = finishTool(
        id,
        event.tool_name === 'Bash' && event.is_interrupt === true ? 'stopped' : false,
        error,
        event.tool_name === 'Bash' ? { status: 'receipt-only' } : undefined,
      );
      turn.sendInsertion();
      const pointer =
        saved && error.length > inlineOutputLimit
          ? [outputPointer(id, error.length), saved.bashLog && bashLogNotice(id, saved.bashLog)]
              .filter(Boolean)
              .join('\n')
          : undefined;
      if (pointer) pagedOutputIds.add(id);
      const context = [feedbackFor(id), pointer].filter(Boolean).join('\n');
      if (context)
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUseFailure' as const,
            additionalContext: context,
          },
        };
    }
    return {};
  };

  return {
    PreToolUse: [{ hooks: [preTool], onFailure: 'block' as const, timeout: 30 }],
    PostToolUse: [{ hooks: [postTool] }],
    PostToolUseFailure: [{ hooks: [postToolFailure] }],
  };
}
