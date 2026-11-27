/**
 * @file 装配运行的 Atelier MCP 工具并统一处理 SDK 工具回执。
 * @implementation 以运行提供的能力核验票据和工作区，在子任务取消作用域内执行工具并归还在途登记，同时按原注册顺序组装工具。
 * @updated 2026-11-27T17:26:33+08:00
 */
import type { AsyncLocalStorage } from 'node:async_hooks';
import { tool, type createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type {
  AgentCapability,
  Extension,
  Run,
  SkillToolBinding,
  Step,
  ToolCall,
} from '../../../../shared/types.js';
import type { FileRecords } from '../../../artifacts.js';
import type { DesktopBrowserAccess } from '../../../desktop-browser-access.js';
import type { EnabledMcp } from '../../../extensions.js';
import { callMcp, type McpSessions } from '../../../extension-mcp.js';
import type { RequestedOperation } from '../../../permissions.js';
import type { RunSkill } from '../../../run-skills.js';
import type { executeSkillPackage } from '../../../skill-package-runtime.js';
import { customOutputSummary, modelOutputSummary } from '../../../tool-output-context.js';
import { registerBrowserTools } from './browser-tools.js';
import { registerBuiltinTools, registerWeatherAndCommand } from './builtin-tools.js';
import { registerExtensionTools, registerSkillBindings } from './extension-tools.js';

export interface RunMcpToolHost {
  run: Run;
  projectId: string;
  workingDirectory: string;
  native: boolean;
  automaticApproval: boolean;
  allowed(capability: AgentCapability): boolean;
  verifyCurrent(): void;
  verifyDispatch(): Promise<void>;
  signal: AbortSignal;
  toolSignal(): AbortSignal;
  branchSignal(subagentId: string): AbortSignal | undefined;
  toolContext: Pick<AsyncLocalStorage<AbortSignal>, 'run'>;
  toolWork: Pick<Map<Promise<unknown>, string | undefined>, 'set' | 'delete'>;
  commands: Pick<Set<Promise<unknown>>, 'add' | 'delete'>;
  sendInsertion(): void;
  claimTool(
    ticket: unknown,
    name: string,
    args: Record<string, unknown>,
  ): { id: string; subagentId?: string } | undefined;
  finishTool(id: string, ok: boolean, output: string): ToolCall | undefined;
  cleanError(error: unknown): string;
  pagedOutputIds: Set<string>;
  updatePlan(steps: Step[]): void;
  getTool(id: string): ToolCall;
  getExtension(id: string): Extension;
  event(type: string, payload: Record<string, unknown>): void;
  approve(operation: RequestedOperation, signal: AbortSignal): Promise<unknown>;
  writeProject<T>(effect: () => Promise<T>): Promise<T>;
  artifacts: Pick<FileRecords, 'publish' | 'publishScreenshot' | 'toolOutput'>;
  browserAccess?: Pick<DesktopBrowserAccess, 'signal' | 'verify'>;
  mcp: readonly EnabledMcp[];
  mcpSessions?: McpSessions;
  skillBindings: readonly {
    skill: Pick<NonNullable<Run['extensions']>[number], 'id' | 'name' | 'version'>;
    binding: SkillToolBinding;
  }[];
  readSkillBindings(skillId: string): SkillToolBinding[];
  weatherEnabled: boolean;
  packages: ReadonlyMap<string, RunSkill>;
  storage: string;
  executePackage(
    options: Omit<Parameters<typeof executeSkillPackage>[0], 'storage' | 'run' | 'files'>,
  ): Promise<unknown>;
}

type McpTools = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>;

export interface ToolRegistration {
  custom: ReturnType<typeof createCustomTool>;
  path: z.ZodString;
  reason: z.ZodString;
  mcpTools: McpTools;
}

function createCustomTool(host: RunMcpToolHost) {
  const {
    signal,
    branchSignal,
    toolContext,
    toolWork,
    sendInsertion,
    claimTool,
    finishTool,
    cleanError,
    pagedOutputIds,
    verifyDispatch,
  } = host;
  const custom = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: S,
    handler: (args: z.infer<z.ZodObject<S>>, id: string) => Promise<unknown>,
  ) =>
    tool(name, description, { ...schema, atelierTicket: z.string().optional() }, async (input) => {
      const fullName = 'mcp__atelier__' + name;
      const { atelierTicket, ...args } = input;
      const entry = claimTool(atelierTicket, fullName, args);
      if (!entry)
        return {
          isError: true,
          content: [{ type: 'text' as const, text: '工具调用与已验证参数不匹配，操作未执行。' }],
        };
      const { id } = entry;
      const branch = entry.subagentId ? branchSignal(entry.subagentId) : undefined;
      const scope = branch ? AbortSignal.any([signal, branch]) : signal;
      const work = toolContext.run(scope, async () => {
        try {
          await verifyDispatch();
          const result = await handler(z.object(schema).parse(args), id);
          const output = typeof result === 'string' ? result : JSON.stringify(result);
          const saved = finishTool(id, true, output);
          const summary = saved ? customOutputSummary(fullName, id, result, output) : undefined;
          if (summary) pagedOutputIds.add(id);
          return { content: [{ type: 'text' as const, text: summary ?? output }] };
        } catch (error) {
          const output = cleanError(error);
          const saved = finishTool(id, false, output);
          const summary = saved ? modelOutputSummary(id, output, '失败') : undefined;
          if (summary) pagedOutputIds.add(id);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: summary ?? output }],
          };
        }
      });
      toolWork.set(work, entry.subagentId);
      try {
        return await work;
      } finally {
        toolWork.delete(work);
        sendInsertion();
      }
    });
  return custom;
}

export function buildRunMcpTools(host: RunMcpToolHost, dispatchMcp: typeof callMcp = callMcp) {
  const mcpTools: McpTools = [];
  const registration = {
    custom: createCustomTool(host),
    path: z.string().min(1).max(1000),
    reason: z.string().min(1).max(1000),
    mcpTools,
  };
  registerBuiltinTools(host, registration);
  const publishScreenshot = host.allowed('artifact')
    ? async (data: string) => {
        host.verifyCurrent();
        return (await host.artifacts.publishScreenshot(host.run, data)).id;
      }
    : undefined;
  const mcpExecution = { ...host, publishScreenshot, dispatchMcp };
  registerBrowserTools(host, registration, publishScreenshot);
  const bindingGuidance = registerSkillBindings(mcpExecution, registration);
  registerWeatherAndCommand(host, registration);
  registerExtensionTools(mcpExecution, registration);
  return { mcpTools, bindingGuidance };
}
