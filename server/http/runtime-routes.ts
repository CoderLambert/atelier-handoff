/**
 * @file 装配工作台运行时的全部 HTTP 领域路由。
 * @implementation 聚合核心领域路由并保持匹配顺序，避免顶层 app.ts 超过热点行数上限。
 * @updated 2026-11-27T15:10:00+08:00
 */
import type { ServerResponse } from 'node:http';
import type { AgentProfiles } from '../agent-profiles.js';
import type { FileRecords } from '../artifacts.js';
import type { McpSessions } from '../extension-mcp.js';
import type { ProjectExtensions } from '../extensions.js';
import type { GatewayService } from '../modules/gateway/service.js';
import type { CommitAnalysisSessions } from '../modules/git/commit-analysis-sessions.js';
import type { DevelopmentWorktrees } from '../modules/git/development-worktrees.js';
import type { ProjectService } from '../modules/projects/service.js';
import type { RunControls } from '../modules/runs/controls.js';
import type { StartRun } from '../modules/runs/create-run.js';
import type { ScheduleScheduler } from '../modules/schedules/scheduler.js';
import type { ScheduleService } from '../modules/schedules/service.js';
import type { SessionAttachments } from '../modules/sessions/attachments.js';
import type { createGetSessionSnapshot } from '../modules/sessions/get-session-snapshot.js';
import type { SessionLifecycle } from '../modules/sessions/lifecycle.js';
import type { SkillScope } from '../modules/skills/scope.js';
import type { TerminalManager } from '../modules/terminal/manager.js';
import type { PermissionService } from '../permissions.js';
import type { RtkSettings } from '../rtk-settings.js';
import type { SessionForks } from '../session-forks.js';
import type { SkillInheritance } from '../skill-inheritance.js';
import { readSkillToolBindings, saveSkillToolBindings } from '../skill-tool-bindings.js';
import type { Store } from '../store.js';
import type { QueueActions } from '../modules/message-queue/actions.js';
import { createAgentRoutes } from './agents/routes.js';
import { createBootstrapRoutes } from './bootstrap/routes.js';
import { createChannelRoutes } from './channels/routes.js';
import { createEventRoutes } from './events/routes.js';
import { createExtensionRoutes } from './extensions/routes.js';
import { createArtifactRoutes } from './files/artifact-routes.js';
import { createToolOutputRoutes } from './files/tool-output-routes.js';
import { createGitRoutes } from './git/routes.js';
import { createPermissionRoutes } from './permissions/routes.js';
import { createRunRoutes } from './runs/routes.js';
import { createScheduleRoutes } from './schedules/routes.js';
import { createScheduleTriggerRoutes } from './schedules/trigger-routes.js';
import { createAttachmentRoutes } from './sessions/attachment-routes.js';
import { createSessionMessageRoutes } from './sessions/message-routes.js';
import { createSessionRoutes } from './sessions/routes.js';
import { createTaskPlanningRoutes } from './settings/task-planning.js';
import { createSettingsRoutes } from './settings/routes.js';
import { createSkillRoutes } from './skills/routes.js';
import { createTerminalRoutes } from './terminal/routes.js';
import { createTextEnhancementRoutes } from './text-enhancement-routes.js';
import type { RouteHandler } from './types.js';

export function buildRuntimeRoutes(deps: {
  store: Store;
  projects: ProjectService;
  projectRoute: RouteHandler;
  gateway: GatewayService;
  csrfToken: string;
  streams: Set<ServerResponse>;
  terminals: TerminalManager;
  skills: SkillScope;
  inheritance: SkillInheritance;
  nativeExecution: boolean;
  desktopPaired: boolean;
  wakeQueue(): void;
  isShuttingDown(): boolean;
  rtkSettings: RtkSettings;
  rtkBinary?: string;
  agents: AgentProfiles;
  extensions: ProjectExtensions;
  mcpSessions: McpSessions;
  publicSourceFetch: Parameters<typeof createExtensionRoutes>[0]['publicSourceFetch'];
  worktrees: DevelopmentWorktrees;
  commitAnalyses: CommitAnalysisSessions;
  lifecycle: SessionLifecycle;
  snapshot: ReturnType<typeof createGetSessionSnapshot>;
  forks: SessionForks;
  createRun: StartRun;
  queue: QueueActions;
  files: FileRecords;
  attachments: SessionAttachments;
  schedules: ScheduleService;
  scheduleScheduler: ScheduleScheduler;
  runControls: RunControls;
  permissions: PermissionService;
}): RouteHandler[] {
  const { store, files } = deps;
  return [
    createScheduleTriggerRoutes(deps.schedules, deps.scheduleScheduler),
    createTerminalRoutes(deps.terminals),
    createTextEnhancementRoutes(deps.gateway),
    createBootstrapRoutes({
      store,
      projects: deps.projects,
      gateway: deps.gateway,
      csrfToken: deps.csrfToken,
    }),
    createEventRoutes(store, deps.streams),
    createSkillRoutes({
      store,
      skills: deps.skills,
      inheritance: deps.inheritance,
      nativeExecution: deps.nativeExecution,
      wakeQueue: deps.wakeQueue,
    }),
    createTaskPlanningRoutes(store, deps.isShuttingDown),
    createSettingsRoutes({
      gateway: deps.gateway,
      isShuttingDown: deps.isShuttingDown,
      workspaceLayout: store.workspaceLayout,
      gitMultiCommitPreferences: store.gitMultiCommitPreferences,
      shortcutPreferences: store.shortcutPreferences,
      rtkSettings: deps.rtkSettings,
      rtkBinary: deps.rtkBinary,
      nativeExecution: deps.nativeExecution,
      requireProject: (id) => {
        store.get('projects', id);
      },
    }),
    createAgentRoutes(deps.agents),
    createExtensionRoutes({
      extensions: deps.extensions,
      mcpSessions: deps.mcpSessions,
      getProject: (id) => store.get('projects', id),
      githubPublicAuth: store.githubPublicAuth,
      publicSourceFetch: deps.publicSourceFetch,
      skillToolBindings: {
        read: (projectId, skillId) => readSkillToolBindings(store, projectId, skillId),
        save: (projectId, skillId, input) =>
          saveSkillToolBindings(store, projectId, skillId, input),
      },
    }),
    createGitRoutes({
      store,
      worktrees: deps.worktrees,
      commitAnalyses: deps.commitAnalyses,
      gateway: deps.gateway,
      desktopPaired: deps.desktopPaired,
      streams: deps.streams,
      isShuttingDown: deps.isShuttingDown,
    }),
    deps.projectRoute,
    createSessionRoutes({
      store,
      lifecycle: deps.lifecycle,
      snapshot: deps.snapshot,
      forks: deps.forks,
      worktrees: deps.worktrees,
      messages: createSessionMessageRoutes({ store, createRun: deps.createRun, queue: deps.queue }),
      attachments: createAttachmentRoutes({
        directory: store.directory,
        files,
        attachments: deps.attachments,
      }),
    }),
    createScheduleRoutes(deps.schedules, deps.scheduleScheduler),
    createChannelRoutes(store),
    createRunRoutes(store, deps.runControls),
    createToolOutputRoutes(store, files),
    createPermissionRoutes(store, deps.permissions),
    createArtifactRoutes(store, files),
  ];
}
