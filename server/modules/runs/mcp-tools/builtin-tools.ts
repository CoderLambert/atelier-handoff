/**
 * @file 注册运行的计划、项目文件、交付物、工具输出和检索工具。
 * @implementation 按执行模式及智能体能力装配工具和计划说明，委托审批、工作区写入、输出分页和命令在途登记。
 * @updated 2026-11-28T18:50:22+08:00
 */
import { z } from 'zod';
import { AppError } from '../../../../shared/errors.js';
import { commandsAvailable, runCommand } from '../../../commands.js';
import {
  applyText,
  listProjectFiles,
  readProjectText,
  resolveProjectPath,
  searchProject,
  MAX_TEXT,
} from '../../../files.js';
import { gatewaySearchArgs, searchGateway } from '../../../gateway-search.js';
import { canReadToolOutput } from '../../../tool-output-context.js';
import { searchToolOutput } from '../../../tool-output-search.js';
import { lookupWeather, weatherLocation } from '../../../weather.js';
import { describeTaskPlanTool, taskPlanSteps } from '../task-plan-guidance.js';
import type { RunMcpToolHost, ToolRegistration } from './types.js';

export function registerBuiltinTools(host: RunMcpToolHost, registration: ToolRegistration) {
  const { custom, mcpTools, path, reason } = registration;
  const {
    run,
    native,
    allowed,
    workingDirectory,
    toolSignal,
    verifyCurrent,
    artifacts,
    approve,
    writeProject,
    pagedOutputIds,
    updatePlan,
    getTool,
  } = host;
  mcpTools.push(
    ...[
      custom(
        'update_plan',
        describeTaskPlanTool(run.taskPlanning?.mode ?? 'auto'),
        { steps: taskPlanSteps.min(1) },
        async (args) => {
          updatePlan(args.steps);
          return { recorded: true, steps: args.steps };
        },
      ),
      custom(
        'list_files',
        'List a project directory. Excludes private settings, secrets, links, and dependencies. Paths are project-relative.',
        { path: z.string().default('') },
        async (args) => listProjectFiles(workingDirectory, args.path),
      ),
      custom(
        'search_files',
        'Search project UTF-8 text for a literal substring. Returns matching relative paths, line numbers, and snippets; output limits are explicit.',
        { query: z.string().min(1).max(200) },
        async (args) => searchProject(workingDirectory, args.query, toolSignal()),
      ),
      custom(
        'publish_artifact',
        'Create an immutable downloadable document as an explicit deliverable. Provide its full content OR an existing project path, not both. This does not modify project files.',
        {
          name: z.string().min(1).max(160),
          content: z
            .string()
            .max(1024 * 1024)
            .optional(),
          path: path.optional(),
        },
        async (args) => {
          let text: string;
          if (args.content !== undefined && args.path === undefined) {
            text = args.content;
          } else if (args.content === undefined && args.path !== undefined) {
            if (!allowed('read'))
              throw new AppError('AGENT_CAPABILITY_DENIED', '此智能体未启用项目文件读取。', 403);
            text = await readProjectText(workingDirectory, args.path, 1024 * 1024);
          } else {
            throw new AppError('INVALID_INPUT', '必须指定成果内容或一个已有项目路径。');
          }
          verifyCurrent();
          return artifacts.publish(run, args.name, text);
        },
      ),
    ].filter((entry) => {
      switch (entry.name) {
        case 'update_plan':
          return allowed('plan');
        case 'list_files':
          return !native && allowed('read');
        case 'search_files':
          return !native && allowed('search');
        case 'publish_artifact':
          return allowed('artifact');
        default:
          return false;
      }
    }),
  );
  mcpTools.push(
    custom(
      'read_tool_output',
      'Find evidence in a recorded result by ID. For known terms pass query: a case-sensitive, single-line literal. Search defaults to the readable log (view: "log") with bounded nearby lines and UTF-16 offsets. Continue a search with query + nextOffset. Read a page around a match with view: "log" + its offset, omitting query. Plain paging defaults to the original SDK receipt, offset 0, limit 2000 (max 8000).',
      {
        toolCallId: z.string().min(1).max(300),
        query: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[^\r\n]+$/u)
          .optional(),
        view: z.enum(['receipt', 'log']).optional(),
        offset: z.int().nonnegative().optional(),
        limit: z.int().min(1).max(8000).optional(),
      },
      async (
        {
          toolCallId,
          query,
          view = query === undefined ? 'receipt' : 'log',
          offset = 0,
          limit = 2000,
        },
        readerId,
      ) => {
        const reader = getTool(readerId);
        const item = getTool(toolCallId);
        if (!canReadToolOutput(native, reader, item, pagedOutputIds))
          throw new AppError('NOT_FOUND', '当前会话没有该工具结果。', 404);
        const output = await artifacts.toolOutput(toolCallId, view === 'log');
        verifyCurrent();
        const coverage = view === 'log' && item.bashLog ? { bashLog: item.bashLog } : {};
        if (query !== undefined)
          return { toolCallId, view, ...coverage, ...searchToolOutput(output, query, offset) };
        return {
          toolCallId,
          view,
          ...coverage,
          offset,
          total: output.length,
          excerpt: output.slice(offset, offset + limit),
          nextOffset: offset + limit < output.length ? offset + limit : null,
        };
      },
    ),
  );
  if (allowed('search'))
    mcpTools.push(
      custom(
        'web_search',
        'Search public web pages on one website through the current model gateway. Use for requested web research. Supply a domain such as baidu.com and a concise public query. Report only verified URLs from sources.',
        gatewaySearchArgs,
        async (args) => searchGateway(run.config, args, toolSignal()),
      ),
    );
  if (!native && run.mode === 'edit' && allowed('write'))
    mcpTools.push(
      custom(
        'write_file',
        'Create or replace a UTF-8 project file. The user must approve the exact before/after contents before execution. Do not retry a denied operation.',
        { path, content: z.string().max(MAX_TEXT), reason },
        async (args, id) => {
          await resolveProjectPath(workingDirectory, args.path, { create: true });
          let before: string | null = null;
          try {
            before = await readProjectText(workingDirectory, args.path);
          } catch (error) {
            if (!(error instanceof AppError) || error.code !== 'FILE_UNAVAILABLE') throw error;
          }
          await approve(
            {
              toolCallId: id,
              kind: 'write',
              path: args.path,
              before,
              after: args.content,
              reason: args.reason,
            },
            toolSignal(),
          );
          const hash = await writeProject(() =>
            applyText(
              workingDirectory,
              args.path,
              before,
              args.content,
              toolSignal(),
              verifyCurrent,
            ),
          );
          return { path: args.path, fingerprint: hash, applied: true };
        },
      ),
      custom(
        'edit_file',
        'Replace an exact unique string in an existing project file. Read the file first. The run approval policy applies to the precise diff and baseline; changed files require a new operation.',
        {
          path,
          oldText: z.string().min(1).max(MAX_TEXT),
          newText: z.string().max(MAX_TEXT),
          reason,
        },
        async (args, id) => {
          const before = await readProjectText(workingDirectory, args.path);
          if (before.split(args.oldText).length !== 2)
            throw new AppError('AMBIGUOUS_EDIT', '待替换文本必须精确且只出现一次。');
          const after = before.replace(args.oldText, () => args.newText);
          await approve(
            { toolCallId: id, kind: 'edit', path: args.path, before, after, reason: args.reason },
            toolSignal(),
          );
          return {
            path: args.path,
            fingerprint: await writeProject(() =>
              applyText(workingDirectory, args.path, before, after, toolSignal(), verifyCurrent),
            ),
            applied: true,
          };
        },
      ),
      custom(
        'delete_file',
        'Delete one existing regular file under the run approval policy. The decision covers the original file contents; directories cannot be deleted.',
        { path, reason },
        async (args, id) => {
          const before = await readProjectText(workingDirectory, args.path);
          await approve(
            {
              toolCallId: id,
              kind: 'delete',
              path: args.path,
              before,
              after: null,
              reason: args.reason,
            },
            toolSignal(),
          );
          await writeProject(() =>
            applyText(workingDirectory, args.path, before, null, toolSignal(), verifyCurrent),
          );
          return { path: args.path, deleted: true };
        },
      ),
    );
}

export function registerWeatherAndCommand(host: RunMcpToolHost, registration: ToolRegistration) {
  const { custom, mcpTools, reason } = registration;
  const {
    weatherEnabled,
    native,
    run,
    allowed,
    approve,
    workingDirectory,
    toolSignal,
    writeProject,
    commands,
  } = host;
  if (weatherEnabled)
    mcpTools.push(
      custom(
        'weather_lookup',
        'Read current weather and a three-day forecast from wttr.in. Only the requested place is sent to the provider. Report the matched place and ask for clarification if it does not match.',
        { location: weatherLocation },
        async (args) => lookupWeather(args.location, toolSignal()),
      ),
    );
  if (!native && run.mode === 'edit' && allowed('command') && commandsAvailable())
    mcpTools.push(
      custom(
        'run_command',
        'Run one approved shell command in an isolated Linux workspace. No network, host home, or background execution. Node is on PATH. The project is mounted at /workspace. Timeout 60 seconds.',
        { command: z.string().min(1).max(4000), reason },
        async (args, id) => {
          await approve(
            {
              toolCallId: id,
              kind: 'command',
              command: args.command,
              reason: `${args.reason}（隔离目录 /workspace，无网络，最长 60 秒）`,
            },
            toolSignal(),
          );
          const work = writeProject(() => runCommand(workingDirectory, args.command, toolSignal()));
          commands.add(work);
          try {
            const result = await work;
            if (result.code !== 0)
              throw new AppError('COMMAND_FAILED', `命令退出 ${result.code}\n${result.output}`);
            return result;
          } finally {
            commands.delete(work);
          }
        },
      ),
    );
}
