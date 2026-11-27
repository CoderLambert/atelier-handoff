/**
 * @file 验证运行 MCP 工具装配、调用边界和审批语义。
 * @implementation 使用实际 SDK 工具定义、内存运行状态和派发替身，检查票据、参数上限、授权漂移及调用事件。
 * @updated 2026-11-27T17:26:33+08:00
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import type { EnabledMcp } from '../server/extensions.js';
import { invokeCheckedMcp } from '../server/modules/runs/mcp-tools/checked-mcp.js';
import { buildRunMcpTools, type RunMcpToolHost } from '../server/modules/runs/mcp-tools/index.js';
import type { RequestedOperation } from '../server/permissions.js';
import { AppError, type Extension, type Run, type SkillToolBinding } from '../shared/types.js';

const args = { value: '广州' };
const workingDirectory = '/workspace';
const skill = {
  kind: 'skill',
  id: 'skill',
  projectId: 'project',
  version: 1,
  name: 'forecast',
  description: '',
  source: 'atelier',
  enabled: true,
  body: '',
  supported: true,
  userInvocable: true,
} satisfies Extension;

function service(access: 'read' | 'approval', shared = false): EnabledMcp {
  return {
    kind: 'mcp',
    id: 'mcp',
    projectId: shared ? 'other-project' : 'project',
    name: 'data',
    description: '',
    source: 'atelier',
    enabled: true,
    version: 1,
    status: 'connected',
    shareAcrossProjects: shared,
    transport: { type: 'stdio', command: 'fixture', args: [], envNames: [] },
    allowedTools: [{ name: 'lookup', access }],
    tools: [{ name: 'lookup', description: 'Look up a value.', inputSchema: { type: 'object' } }],
  };
}

function unexpected(): never {
  throw new Error('unexpected fixture operation');
}

function fixture(server: EnabledMcp, mode: Run['mode'] = 'edit', withBinding = false) {
  const run: Run = {
    id: 'run',
    sessionId: 'session',
    projectId: 'project',
    prompt: '',
    status: 'running',
    mode,
    approvalMode: 'automatic',
    createdAt: '2026-11-27T00:00:00Z',
    startedAt: null,
    endedAt: null,
    reason: null,
    error: null,
    retryOf: null,
    contextPaths: [],
    attachmentIds: [],
    plan: [],
    usage: null,
    config: { gateway: 'https://example.invalid', model: 'fixture', maxTurns: 1, timeoutMs: 1000 },
  };
  const binding: SkillToolBinding = {
    kind: 'mcp',
    name: 'lookup',
    extensionId: server.id,
    tool: 'lookup',
  };
  const extensions = new Map<string, Extension>([
    [server.id, server],
    [skill.id, skill],
  ]);
  const cancellation = new AbortController();
  const toolContext = new AsyncLocalStorage<AbortSignal>();
  const toolWork = new Map<Promise<unknown>, string | undefined>();
  const approvals: RequestedOperation[] = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const errors: unknown[] = [];
  const finished: { id: string; ok: boolean; output: string }[] = [];
  const insertionWorkSizes: number[] = [];
  const host: RunMcpToolHost = {
    run,
    projectId: run.projectId,
    workingDirectory,
    native: false,
    automaticApproval: true,
    allowed: (capability) => capability !== 'command',
    verifyCurrent: () => host.toolSignal().throwIfAborted(),
    verifyDispatch: async () => host.verifyCurrent(),
    signal: cancellation.signal,
    toolSignal: () => toolContext.getStore() ?? cancellation.signal,
    branchSignal: () => undefined,
    toolContext,
    toolWork,
    commands: new Set(),
    sendInsertion: () => insertionWorkSizes.push(toolWork.size),
    claimTool: (ticket, name, input) =>
      ticket === 'ticket' && name.startsWith('mcp__atelier__') && 'arguments' in input
        ? { id: 'tool-call' }
        : undefined,
    finishTool: (id, ok, output) => {
      finished.push({ id, ok, output });
      return undefined;
    },
    cleanError: (error) => {
      errors.push(error);
      return error instanceof Error ? error.message : '执行失败。';
    },
    pagedOutputIds: new Set(),
    updatePlan: unexpected,
    getTool: unexpected,
    getExtension: (id) => extensions.get(id) ?? unexpected(),
    event: (type, payload) => events.push({ type, payload }),
    approve: async (operation) => approvals.push(operation),
    writeProject: unexpected,
    artifacts: { publish: unexpected, publishScreenshot: unexpected, toolOutput: unexpected },
    mcp: withBinding ? [] : [server],
    skillBindings: withBinding ? [{ skill, binding }] : [],
    readSkillBindings: () => [binding],
    weatherEnabled: true,
    packages: new Map(),
    storage: '/data',
    executePackage: unexpected,
  };
  return {
    host,
    extensions,
    cancellation,
    approvals,
    events,
    errors,
    finished,
    toolWork,
    insertionWorkSizes,
  };
}

function invoke(
  { mcpTools }: ReturnType<typeof buildRunMcpTools>,
  name: string,
  ticket = 'ticket',
) {
  const registered = mcpTools.find((entry) => entry.name === name);
  assert.ok(registered, `missing ${name}`);
  return registered.handler({ arguments: args, atelierTicket: ticket }, {});
}

const identity = { server: 'data', tool: 'lookup', toolCallId: 'tool-call' };

test('MCP argument limit counts encoded UTF-8 bytes before approval or dispatch', async () => {
  const server = service('approval');
  for (const source of [{ kind: 'binding' }, { kind: 'external', shared: false }] as const) {
    const { host, approvals, events } = fixture(server);
    let checks = 0;
    const result = invokeCheckedMcp(
      { ...host, dispatchMcp: unexpected },
      {
        source,
        server,
        name: 'lookup',
        access: 'approval',
        args: { value: '界'.repeat(22_000) },
        toolCallId: 'tool-call',
        recheck: () => checks++,
      },
    );
    await assert.rejects(result, {
      code: 'MCP_ARGUMENTS_TOO_LARGE',
      status: 413,
      message: 'MCP 工具参数过大。',
    });
    assert.equal(checks, source.kind === 'binding' ? 1 : 0);
    assert.deepEqual(approvals, []);
    assert.deepEqual(events, []);
  }
});

test('registration preserves ordering, descriptors and ticket rejection, and skips a stale grant definition', async () => {
  const server = service('read');
  server.allowedTools.unshift({ name: 'missing', access: 'read' });
  const { host, finished, toolWork, insertionWorkSizes } = fixture(server);
  const branch = new AbortController();
  host.branchSignal = (id) => {
    assert.equal(id, 'subagent');
    return branch.signal;
  };
  host.claimTool = (ticket, name, input) => {
    assert.equal(name, 'mcp__atelier__external_0_1');
    assert.deepEqual(input, { arguments: args });
    return ticket === 'ticket' ? { id: 'tool-call', subagentId: 'subagent' } : undefined;
  };
  const tools = buildRunMcpTools(host, async (_server, _cwd, _name, _args, _signal, beforeCall) => {
    assert.deepEqual([...toolWork.values()], ['subagent']);
    assert.notEqual(host.toolSignal(), host.signal);
    assert.ok(beforeCall);
    await beforeCall();
    return 'receipt';
  });
  assert.deepEqual(
    tools.mcpTools.map(({ name }) => name),
    [
      'update_plan',
      'list_files',
      'search_files',
      'publish_artifact',
      'read_tool_output',
      'web_search',
      'write_file',
      'edit_file',
      'delete_file',
      'weather_lookup',
      'external_0_1',
    ],
  );
  const external = tools.mcpTools.find(({ name }) => name === 'external_0_1');
  assert.equal(
    external?.description,
    'data/lookup — Look up a value.\nInput JSON Schema: {"type":"object"}',
  );
  assert.deepEqual(await invoke(tools, 'external_0_1', 'forged'), {
    isError: true,
    content: [{ type: 'text', text: '工具调用与已验证参数不匹配，操作未执行。' }],
  });
  assert.deepEqual(finished, []);
  assert.deepEqual(insertionWorkSizes, []);
  assert.deepEqual(await invoke(tools, 'external_0_1'), {
    content: [{ type: 'text', text: 'receipt' }],
  });
  assert.deepEqual(finished, [{ id: 'tool-call', ok: true, output: 'receipt' }]);
  assert.deepEqual(insertionWorkSizes, [0]);
});

for (const withBinding of [false, true]) {
  for (const phase of ['before approval', 'after approval', 'before dispatch'] as const) {
    test(`${withBinding ? 'bound' : 'external'} MCP rejects authorization drift ${phase}`, async () => {
      const server = service('approval');
      const { host, extensions, approvals, errors } = fixture(server, 'edit', withBinding);
      const name = withBinding ? 'skill_tool_0_lookup' : 'external_0_0';
      let dispatches = 0;
      let effects = 0;
      let workspaceChecks = 0;
      host.verifyDispatch = async () => {
        workspaceChecks++;
        host.verifyCurrent();
      };
      if (phase === 'after approval') {
        const approve = host.approve;
        host.approve = async (operation, signal) => {
          await approve(operation, signal);
          extensions.set(server.id, {
            ...server,
            allowedTools: [{ name: 'lookup', access: 'read' }],
          });
        };
      }
      const tools = buildRunMcpTools(
        host,
        async (_server, _cwd, _name, _args, _signal, beforeCall) => {
          dispatches++;
          extensions.set(server.id, { ...server, enabled: false });
          assert.ok(beforeCall);
          await beforeCall();
          effects++;
          return 'receipt';
        },
      );
      if (phase === 'before approval') extensions.set(server.id, { ...server, version: 2 });
      assert.equal((await invoke(tools, name)).isError, true);
      assert.equal(approvals.length, phase === 'before approval' ? 0 : 1);
      assert.equal(dispatches, phase === 'before dispatch' ? 1 : 0);
      assert.equal(workspaceChecks, phase === 'before dispatch' ? 2 : 1);
      if (!withBinding && phase !== 'before approval')
        assert.equal(approvals[0]?.requireManual, false);
      assert.equal(effects, 0);
      assert.equal(errors.length, 1);
      assert.ok(errors[0] instanceof AppError);
      assert.equal(errors[0].status, 403);
      assert.equal(errors[0].code, withBinding ? 'SKILL_TOOL_UNAVAILABLE' : 'MCP_TOOL_NOT_ALLOWED');
      assert.equal(
        errors[0].message,
        withBinding
          ? 'Skill 工具未授权、已变更或当前运行模式不可用。'
          : 'MCP 工具授权或配置已变更。',
      );
    });
  }
}

test('shared external MCP rejects readonly mode before approval, events or dispatch', async () => {
  const { host, approvals, events, errors } = fixture(service('read', true), 'readonly');
  const result = await invoke(buildRunMcpTools(host, unexpected), 'external_0_0');
  assert.equal(result.isError, true);
  assert.ok(errors[0] instanceof AppError);
  assert.equal(errors[0].code, 'MCP_TOOL_NOT_ALLOWED');
  assert.equal(errors[0].status, 403);
  assert.equal(errors[0].message, '此工具需要受控修改模式。');
  assert.deepEqual(approvals, []);
  assert.deepEqual(events, []);
});

for (const status of ['succeeded', 'failed', 'canceled'] as const) {
  test(`shared external MCP requests manual approval and records ${status}`, async () => {
    const server = service('read', true);
    const { host, cancellation, approvals, events } = fixture(server);
    const tools = buildRunMcpTools(
      host,
      async (selected, cwd, name, input, signal, beforeCall, _sessions, _screenshot, projectId) => {
        assert.equal(selected, server);
        assert.equal(cwd, workingDirectory);
        assert.equal(name, 'lookup');
        assert.deepEqual(input, args);
        assert.equal(projectId, host.projectId);
        assert.equal(approvals.length, 1);
        assert.deepEqual(events, [{ type: 'mcp.call_started', payload: identity }]);
        assert.ok(beforeCall);
        await beforeCall();
        if (status === 'failed') throw new AppError('MCP_TOOL_FAILED', 'fixture failure', 502);
        if (status === 'canceled') {
          cancellation.abort();
          assert.equal(signal.aborted, true);
        }
        return 'receipt';
      },
    );
    const result = await invoke(tools, 'external_0_0');
    assert.equal(Boolean(result.isError), status !== 'succeeded');
    assert.deepEqual(approvals, [
      {
        toolCallId: 'tool-call',
        kind: 'mcp',
        command: 'data/lookup\n' + JSON.stringify(args, null, 2),
        reason: '向 MCP 服务 data 发送参数并执行 lookup。',
        requireManual: true,
      },
    ]);
    const code =
      status === 'failed' ? 'MCP_TOOL_FAILED' : status === 'canceled' ? 'RUN_STOPPED' : undefined;
    assert.deepEqual(events, [
      { type: 'mcp.call_started', payload: identity },
      { type: 'mcp.call_finished', payload: { ...identity, status, ...(code && { code }) } },
    ]);
  });
}

for (const access of ['read', 'approval'] as const) {
  test(`bound MCP ${access} grants preserve approval format and binding guidance`, async () => {
    const { host, approvals, events } = fixture(
      service(access),
      access === 'read' ? 'readonly' : 'edit',
      true,
    );
    const tools = buildRunMcpTools(
      host,
      async (
        _server,
        _cwd,
        _name,
        _args,
        _signal,
        beforeCall,
        _sessions,
        _screenshot,
        projectId,
      ) => {
        assert.equal(projectId, undefined);
        assert.ok(beforeCall);
        await beforeCall();
        return 'receipt';
      },
    );
    assert.deepEqual(tools.bindingGuidance, ['forecast / lookup：调用 skill_tool_0_lookup。']);
    assert.deepEqual(await invoke(tools, 'skill_tool_0_lookup'), {
      content: [{ type: 'text', text: 'receipt' }],
    });
    assert.deepEqual(
      approvals,
      access === 'read'
        ? []
        : [
            {
              toolCallId: 'tool-call',
              kind: 'mcp',
              command: 'data/lookup\n' + JSON.stringify(args),
              reason: '向 data 发送参数并执行 lookup。',
            },
          ],
    );
    assert.deepEqual(events, []);
  });
}
