/**
 * @file 定义运行 MCP 工具宿主与注册器共享契约。
 * @implementation 打破 mcp-tools 桶文件与各子注册模块间的仅类型循环依赖，保持单一权威类型来源。
 * @updated 2026-11-27T22:35:00+08:00
 */
import type { AsyncLocalStorage } from 'node:async_hooks';
import type { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
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
import type { McpSessions } from '../../../extension-mcp.js';
import type { RequestedOperation } from '../../../permissions.js';
import type { RunSkill } from '../../../run-skills.js';
import type { executeSkillPackage } from '../../../skill-package-runtime.js';

export type McpTools = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>;

export type CustomToolRegistrar = <S extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.infer<z.ZodObject<S>>, id: string) => Promise<unknown>,
) => McpTools[number];

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

export interface ToolRegistration {
  custom: CustomToolRegistrar;
  path: z.ZodString;
  reason: z.ZodString;
  mcpTools: McpTools;
}
