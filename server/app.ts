/**
 * @file 组装 Atelier 运行时并注册 HTTP 领域路由。
 * @implementation 连接持久化、用例和终端传输，统一管理在途请求、长连接与关停顺序。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { AppError, type Run, type Session } from '../shared/types.js';
import { AgentRunner } from './agent.js';
import { AgentProfiles } from './agent-profiles.js';
import { FileRecords } from './artifacts.js';
import { desktopBrowserEnabled } from './desktop-browser.js';
import { DesktopBrowserAccess } from './desktop-browser-access.js';
import { McpSessions } from './extension-mcp.js';
import { ProjectExtensions } from './extensions.js';
import { createAgentRoutes } from './http/agents/routes.js';
import { createBootstrapRoutes } from './http/bootstrap/routes.js';
import { createEventRoutes } from './http/events/routes.js';
import { createExtensionRoutes } from './http/extensions/routes.js';
import { createArtifactRoutes } from './http/files/artifact-routes.js';
import { createToolOutputRoutes } from './http/files/tool-output-routes.js';
import { createGitRoutes } from './http/git/routes.js';
import { createPermissionRoutes } from './http/permissions/routes.js';
import { createProjectRoutes } from './http/projects/routes.js';
import { createRequestHandler } from './http/request-handler.js';
import { createRunRoutes } from './http/runs/routes.js';
import { createRuntimeHttpServer } from './http/server.js';
import { createAttachmentRoutes } from './http/sessions/attachment-routes.js';
import { createSessionMessageRoutes } from './http/sessions/message-routes.js';
import { createSessionRoutes } from './http/sessions/routes.js';
import { createSettingsRoutes } from './http/settings/routes.js';
import { createSkillRoutes } from './http/skills/routes.js';
import { createTerminalRoutes } from './http/terminal/routes.js';
import { validateTerminalUpgrade } from './http/terminal/upgrade.js';
import { MessageQueue } from './message-queue.js';
import { createGatewayService } from './modules/gateway/service.js';
import { CommitAnalysisSessions } from './modules/git/commit-analysis-sessions.js';
import { DevelopmentWorktrees } from './modules/git/development-worktrees.js';
import { createProjectService } from './modules/projects/service.js';
import { createRunControls } from './modules/runs/controls.js';
import { createExecutionSlots } from './modules/runs/execution-slots.js';
import { createSessionAttachments } from './modules/sessions/attachments.js';
import { createGetSessionSnapshot } from './modules/sessions/get-session-snapshot.js';
import { createSessionLifecycle } from './modules/sessions/lifecycle.js';
import { createSessionOperations } from './modules/sessions/operations.js';
import { createSkillScope } from './modules/skills/scope.js';
import { TerminalManager } from './modules/terminal/manager.js';
import { registerTerminalTransport } from './modules/terminal/transport.js';
import { PermissionService } from './permissions.js';
import { pickProjectDirectory } from './project-picker.js';
import { RtkSettings } from './rtk-settings.js';
import { createMessageRuntime } from './runtime/message-runtime.js';
import type { CreateAppOptions } from './runtime/types.js';
import { SessionForks } from './session-forks.js';
import { SkillInheritance } from './skill-inheritance.js';
import { readSkillToolBindings, saveSkillToolBindings } from './skill-tool-bindings.js';
import { Store } from './store.js';

export async function createApp(options: CreateAppOptions) {
  const desktopPaired = Boolean(options.desktopPairing);
  const nativeExecution =
    options.nativeExecution === true && desktopPaired && process.platform === 'linux';
  let shuttingDown = false;
  const isShuttingDown = () => shuttingDown;
  const store = new Store(options.data);
  const rtkSettings = new RtkSettings(store);
  store.recover();
  const messageQueue = new MessageQueue(store);
  const mcpSessions = new McpSessions();
  const commitAnalyses = new CommitAnalysisSessions();
  const operations = createSessionOperations();
  let scheduler: { wake(): void } | undefined;
  const wakeQueue = () => scheduler?.wake();
  const hasPending = (id: string) => messageQueue.hasPending(id);
  const execution = createExecutionSlots({
    store,
    directory: (session): string => worktrees.directory(session),
    assertUnlocked: (path): void => worktrees.assertUnlocked(path),
    hasPending,
    usingForkSource: (id): boolean => forks.usingSource(id),
  });
  const worktrees = new DevelopmentWorktrees(store, await realpath(store.directory), {
    inUse: execution.directoryInUse,
    closeDirectory: (path) => mcpSessions.closeDirectory(path),
    released: wakeQueue,
  });
  const forks = new SessionForks(store, undefined, hasPending, (session) =>
    worktrees.resolveSession(session),
  );
  await forks.recover();
  await worktrees.recover();

  const verifyWorkspace = (run: Run) => worktrees.verifyRun(run);
  const sessionDirectory = (session: Session) => worktrees.directory(session);
  const permissions = new PermissionService(store, options.permissionTtlMs, verifyWorkspace);
  const files = new FileRecords(store);
  const browserAccess = new DesktopBrowserAccess(
    store,
    () => desktopPaired && desktopBrowserEnabled(),
  );
  const extensions = new ProjectExtensions(store, desktopPaired);
  extensions.assignLegacyProviders();
  const agents = new AgentProfiles(store, extensions);
  const inheritance = new SkillInheritance(store.skillInheritance);
  const skills = createSkillScope({
    store,
    agents,
    extensions,
    inheritance,
    nativeExecution,
    sessionDirectory,
  });
  const runner =
    options.runnerFactory?.(store, permissions, files) ??
    new AgentRunner(
      store,
      permissions,
      files,
      mcpSessions,
      browserAccess,
      verifyWorkspace,
      (id) => {
        if (hasPending(id)) wakeQueue();
      },
      options.rtkBinary
        ? { binary: options.rtkBinary, enabled: (id) => rtkSettings.enabled(id) }
        : undefined,
    );
  const csrfToken = randomBytes(32).toString('hex');
  const gateway = createGatewayService({
    settings: store,
    nativeExecution,
    magpie: options.magpie,
  });
  const terminals = new TerminalManager({
    store,
    worktrees,
    supported: nativeExecution && process.arch === 'x64',
    unavailableReason: !desktopPaired
      ? 'desktop-required'
      : process.platform !== 'linux' || process.arch !== 'x64'
        ? 'platform-unsupported'
        : 'native-execution-disabled',
    isSessionDeleting: operations.isDeleting,
  });

  const { createRun, queue, queueScheduler, readQueue } = createMessageRuntime({
    store,
    worktrees,
    files,
    agents,
    extensions,
    inheritance,
    skills,
    browserAccess,
    runner,
    gateway,
    messageQueue,
    execution,
    nativeExecution,
    hasRunnerFactory: Boolean(options.runnerFactory),
    sessionDirectory,
    isSessionDeleting: operations.isDeleting,
    isShuttingDown,
    wakeQueue,
  });
  scheduler = queueScheduler;
  const snapshot = createGetSessionSnapshot({
    repository: store.sessionSnapshots,
    readTransaction: store.readTransaction,
    boundAgent: (projectId, revisionId) => agents.binding(agents.revision(projectId, revisionId)),
    latestAgent: (projectId, agentId) => agents.card(projectId, agentId),
    queue: readQueue,
  });
  const lifecycle = createSessionLifecycle({
    store,
    worktrees,
    files,
    agents,
    terminals,
    forks,
    messageQueue,
    operations,
    data: options.data,
    nativeExecution,
    sameSessionRunning: execution.sameSessionRunning,
    isShuttingDown,
  });
  const attachments = createSessionAttachments({ store, agents, files, operations, messageQueue });
  const runControls = createRunControls({ store, runner, nativeExecution, createRun });
  const projects = createProjectService(store);
  const projectRoutes = createProjectRoutes({
    projects,
    store,
    worktrees,
    browserAccess,
    pickDirectory: options.pickDirectory ?? pickProjectDirectory,
    isShuttingDown,
  });
  const streams = new Set<ServerResponse>();
  const handle = createRequestHandler({
    root: options.root,
    csrfToken,
    desktopPairing: options.desktopPairing,
    isShuttingDown,
    routes: [
      createTerminalRoutes(terminals),
      createBootstrapRoutes({ store, projects, gateway, csrfToken }),
      createEventRoutes(store, streams),
      createSkillRoutes({ store, skills, inheritance, nativeExecution, wakeQueue }),
      createSettingsRoutes({
        gateway,
        isShuttingDown,
        workspaceLayout: store.workspaceLayout,
        gitMultiCommitPreferences: store.gitMultiCommitPreferences,
        shortcutPreferences: store.shortcutPreferences,
        rtkSettings,
        rtkBinary: options.rtkBinary,
        nativeExecution,
        requireProject: (id) => {
          store.get('projects', id);
        },
      }),
      createAgentRoutes(agents),
      createExtensionRoutes({
        extensions,
        mcpSessions,
        getProject: (id) => store.get('projects', id),
        githubPublicAuth: store.githubPublicAuth,
        publicSourceFetch: options.publicSourceFetch,
        skillToolBindings: {
          read: (projectId, skillId) => readSkillToolBindings(store, projectId, skillId),
          save: (projectId, skillId, input) =>
            saveSkillToolBindings(store, projectId, skillId, input),
        },
      }),
      createGitRoutes({
        store,
        worktrees,
        commitAnalyses,
        gateway,
        desktopPaired,
        streams,
        isShuttingDown,
      }),
      projectRoutes.route,
      createSessionRoutes({
        store,
        lifecycle,
        snapshot,
        forks,
        worktrees,
        messages: createSessionMessageRoutes({ store, createRun, queue }),
        attachments: createAttachmentRoutes({ directory: store.directory, files, attachments }),
      }),
      createRunRoutes(store, runControls),
      createToolOutputRoutes(store, files),
      createPermissionRoutes(store, permissions),
      createArtifactRoutes(store, files),
    ],
  });
  const { server, stopListening, drainConnections } = createRuntimeHttpServer(handle, streams);
  const terminalTransport = registerTerminalTransport(server, terminals, {
    validateUpgrade: (req) => validateTerminalUpgrade(server, req, isShuttingDown),
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      shuttingDown = true;
      projectRoutes.cancelPicker();
      commitAnalyses.close();
      const networkClosed = stopListening();
      try {
        queueScheduler.detachRunnerEvents();
        const results = await Promise.allSettled([
          runner.shutdown(),
          gateway.dispose(),
          queueScheduler.waitForDrain(),
          terminals.shutdown().then((report) => {
            if (report.failed.length)
              throw new AppError(
                'TERMINAL_CLEANUP_FAILED',
                `终端清理未完成：${report.failed.join(', ')}`,
                500,
              );
          }),
          terminalTransport.dispose(),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      } finally {
        await drainConnections();
        await networkClosed;
        await mcpSessions.shutdown();
        store.close();
      }
    })());
  return { server, store, permissions, files, runner, close };
}
