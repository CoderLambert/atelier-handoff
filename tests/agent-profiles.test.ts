import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { callMcp } from '../server/extension-mcp.js';
import type { Runner } from '../server/agent.js';
import { now, type AgentConfig } from '../shared/types.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/extension-mcp.mjs', import.meta.url));

test('project agents bind immutable revisions and combine only authorized Skill and MCP capabilities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-agents-'));
  const workspace = join(directory, 'workspace');
  const otherWorkspace = join(directory, 'outside');
  await Promise.all([mkdir(workspace), mkdir(otherWorkspace)]);
  await writeFile(join(workspace, 'minutes.txt'), '决策：先完成交接。\n');
  const runs: Parameters<Runner['start']>[] = [];
  const jobs = new Map<string, Promise<void>>();
  const app = await createApp({
    root,
    data: join(directory, 'data'),
    runnerFactory: (store, _permissions, files) => ({
      start(...args) {
        runs.push(args);
        const [run, input, mcp, _skills, guard] = args;
        const job = Promise.resolve().then(async () => {
          if (mcp?.length) {
            const reply = await callMcp(
              mcp[0]!,
              workspace,
              'fixture_echo',
              { text: '来源：会议检索' },
              AbortSignal.timeout(8000),
              guard,
            );
            await files.publish(
              run,
              'minutes.md',
              `# 会议整理\n\n${input.includes('先完成交接') ? '决策：先完成交接。' : ''}\n\n${reply}`,
            );
          }
          store.update('runs', run.id, { status: 'completed', endedAt: now() });
        });
        jobs.set(run.id, job);
      },
      stop() {},
      async shutdown() {
        await Promise.allSettled(jobs.values());
      },
    }),
  });
  try {
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const { csrfToken } = await fetch(base + '/api/bootstrap').then((r) => r.json());
    async function api(path: string, method = 'GET', body?: unknown, expected = 200) {
      const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': csrfToken },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const payload = await response.json();
      assert.equal(response.status, expected, JSON.stringify(payload));
      return payload;
    }
    const { project } = await api('/api/projects', 'POST', { path: workspace }, 201);
    const { project: other } = await api('/api/projects', 'POST', { path: otherWorkspace }, 201);
    const endpoint = `/api/projects/${project.id}`;
    const { item: skill } = await api(
      `${endpoint}/extensions`,
      'POST',
      {
        kind: 'skill',
        name: 'meeting-notes',
        description: 'Organize decisions and sources',
        body: 'Use a source list.',
        enabled: true,
      },
      201,
    );
    const { item: extra } = await api(
      `${endpoint}/extensions`,
      'POST',
      {
        kind: 'skill',
        name: 'unlisted',
        description: 'Separate skill',
        body: 'This skill is outside the profile.',
        enabled: true,
      },
      201,
    );
    const transport = { type: 'stdio', command: process.execPath, args: [fixture], envNames: [] };
    const mcp = app.store.put('extensions', {
      id: randomUUID(),
      projectId: project.id,
      name: 'meeting-lookup',
      version: 1,
      kind: 'mcp',
      source: 'fixture',
      enabled: true,
      description: '会议资料查询',
      status: 'connected',
      transport: { ...transport, type: 'stdio' },
      tools: [
        {
          name: 'fixture_echo',
          description: 'Echo fixture text',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      ],
      allowedTools: [{ name: 'fixture_echo', access: 'read' }],
    });
    // Use the test endpoint to record the exact published schema the MCP client will enforce.
    const { item: checkedMcp } = await api(`${endpoint}/extensions/${mcp.id}/test`, 'POST', {
      version: mcp.version,
    });
    const config: AgentConfig = {
      name: '资料整理助手',
      description: '将会议资料整理成交付物',
      instructions: '列出决策、待办和来源。',
      starters: ['整理会议纪要'],
      mode: 'readonly',
      capabilities: ['read', 'context', 'artifact'],
      skills: [{ id: skill.id, version: skill.version, activation: 'auto' }],
      mcp: [{ id: checkedMcp.id, version: checkedMcp.version, tools: ['fixture_echo'] }],
    };
    const agents = `${endpoint}/agents`;
    const { agent: first } = await api(agents, 'POST', config, 201);
    assert.equal(first.version, 1);
    await api(
      '/api/sessions',
      'POST',
      { projectId: other.id, agentRevisionId: first.revisionId },
      404,
    );
    const { session } = await api(
      '/api/sessions',
      'POST',
      { projectId: project.id, agentRevisionId: first.revisionId },
      201,
    );
    const messages = `/api/sessions/${session.id}/messages`;
    const send = (extra: object = {}) => ({
      text: '整理论文会议纪要',
      contextPaths: ['minutes.txt'],
      idempotencyKey: randomUUID(),
      ...extra,
    });
    assert.equal(
      (await api(messages, 'POST', send({ mode: 'edit' }), 403)).error.code,
      'AGENT_MODE_DENIED',
    );
    assert.equal(
      (
        await api(
          messages,
          'POST',
          send({ extensionSelections: [{ id: extra.id, version: extra.version }] }),
          403,
        )
      ).error.code,
      'AGENT_CAPABILITY_DENIED',
    );
    await api(messages, 'POST', send({ text: '/unlisted 议程' }), 400);
    assert.equal(runs.length, 0);
    const submission = send();
    const { run } = await api(messages, 'POST', submission, 202);
    await jobs.get(run.id);
    assert.equal((await api(messages, 'POST', submission, 202)).run.id, run.id);
    assert.equal(runs.length, 1);
    const [accepted, input, tools, skills] = runs[0]!;
    assert.equal(accepted.agent?.revisionId, first.revisionId);
    assert.deepEqual(accepted.agent?.capabilities, config.capabilities);
    assert.match(input, /先完成交接/);
    assert.match(input, /列出决策、待办和来源/);
    assert.deepEqual(
      skills?.map((item) => item.name),
      ['meeting-notes'],
    );
    assert.deepEqual(
      tools?.[0]?.allowedTools.map((tool) => tool.name),
      ['fixture_echo'],
    );
    const snapshot = await api(`/api/sessions/${session.id}`);
    const output = await api(`/api/artifacts/${snapshot.artifacts[0].id}/content`);
    assert.match(output.text, /fixture-result:来源：会议检索/);
    const { agent: second } = await api(`${agents}/${first.id}`, 'PATCH', {
      baseRevisionId: first.revisionId,
      config: { ...config, instructions: '更新的角色指令。' },
    });
    assert.equal(second.version, 2);
    const { session: empty } = await api(
      '/api/sessions',
      'POST',
      { projectId: project.id, agentRevisionId: first.revisionId },
      201,
    );
    await api(`/api/sessions/${empty.id}`, 'PATCH', {
      draft: { ...empty.draft, text: '待发送草稿' },
    });
    await api(
      `/api/sessions/${session.id}/upgrade-agent`,
      'POST',
      { revisionId: first.revisionId },
      409,
    );
    const { session: upgraded } = await api(`/api/sessions/${empty.id}/upgrade-agent`, 'POST', {
      revisionId: first.revisionId,
    });
    assert.equal(upgraded.agentRevisionId, second.revisionId);
    assert.equal(upgraded.draft.text, '待发送草稿');
    assert.equal((await api(`/api/sessions/${session.id}`)).agent.version, 1);
    await api(`${agents}/${first.id}`, 'PATCH', { baseRevisionId: first.revisionId, config }, 409);
    const { run: retry } = await api(
      `/api/runs/${run.id}/retry`,
      'POST',
      { idempotencyKey: randomUUID() },
      202,
    );
    await jobs.get(retry.id);
    assert.equal(retry.agent.version, 1);
    assert.deepEqual(runs[1]![3], []);
    assert.equal(runs[1]![2], undefined);
    await api(`${endpoint}/extensions/${skill.id}`, 'PATCH', {
      version: skill.version,
      enabled: false,
    });
    assert.equal((await api(messages, 'POST', send(), 409)).error.code, 'AGENT_UNAVAILABLE');
    assert.ok((await api(`/api/sessions/${session.id}`)).agent.issues.length);
    assert.throws(() => runs[0]![4]?.(), { code: 'AGENT_UNAVAILABLE' });

    const { agent: editable } = await api(
      agents,
      'POST',
      {
        ...config,
        name: '文档编辑助手',
        mode: 'edit',
        capabilities: ['read', 'write'],
        skills: [],
        mcp: [],
      },
      201,
    );
    assert.equal(editable.version, 1);
    assert.equal(editable.config.mode, 'edit');
    const { session: editSession } = await api(
      '/api/sessions',
      'POST',
      { projectId: project.id, agentRevisionId: editable.revisionId },
      201,
    );
    assert.equal(editSession.draft.mode, 'readonly');
    const editMessages = `/api/sessions/${editSession.id}/messages`;
    const { run: readonlyRun } = await api(
      editMessages,
      'POST',
      { text: '查看文档', idempotencyKey: randomUUID() },
      202,
    );
    await jobs.get(readonlyRun.id);
    assert.deepEqual(readonlyRun.agent.capabilities, ['read']);
    const { run: editRun } = await api(
      editMessages,
      'POST',
      { text: '修改文档', mode: 'edit', idempotencyKey: randomUUID() },
      202,
    );
    await jobs.get(editRun.id);
    assert.deepEqual(editRun.agent.capabilities, ['read', 'write']);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
