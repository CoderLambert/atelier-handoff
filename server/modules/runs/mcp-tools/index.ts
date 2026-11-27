/**
 * @file 装配运行的 Atelier MCP 工具并统一处理 SDK 工具回执。
 * @implementation 以运行提供的能力核验票据和工作区，在子任务取消作用域内执行工具并归还在途登记，同时按原注册顺序组装工具。
 * @updated 2026-11-27T22:35:00+08:00
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { callMcp } from '../../../extension-mcp.js';
import { customOutputSummary, modelOutputSummary } from '../../../tool-output-context.js';
import { registerBrowserTools } from './browser-tools.js';
import { registerBuiltinTools, registerWeatherAndCommand } from './builtin-tools.js';
import { registerExtensionTools, registerSkillBindings } from './extension-tools.js';
import type { CustomToolRegistrar, McpTools, RunMcpToolHost, ToolRegistration } from './types.js';

export type { RunMcpToolHost, ToolRegistration };

function createCustomTool(host: RunMcpToolHost): CustomToolRegistrar {
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
  const custom: CustomToolRegistrar = <S extends z.ZodRawShape>(
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
  const registration: ToolRegistration = {
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
