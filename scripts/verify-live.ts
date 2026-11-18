import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Permission, Run, ToolCall, Artifact, Message } from '../shared/types.js';

if (!process.argv.includes('--authorized'))
  throw new Error(
    'Live model calls consume usage. Obtain authorization, then pass --authorized. Use an acceptance server, not your normal data directory.',
  );
const base = process.env.ATELIER_TEST_URL || 'http://127.0.0.1:4318';
const endpoint = new URL(base);
assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname));
const source = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'atelier-live-suite-'));
const marker = randomUUID();
await writeFile(join(directory, 'note.txt'), 'ORIGINAL\n');
await writeFile(join(directory, 'marker.txt'), marker);
const attachmentMarker = 'attachment-' + randomUUID();
const evidence = join(
  source,
  'docs/evidence',
  new Date().toISOString().replace(/[:.]/g, '-') + '-live',
);
await mkdir(evidence, { recursive: true });
const bootstrap = (await (await fetch(base + '/api/bootstrap')).json()) as {
  csrfToken: string;
  config: unknown;
};
const token = bootstrap.csrfToken;
const receipts: unknown[] = [];
let queryCount = 0;
let currentRunId: string | undefined;
async function api(path: string, method = 'GET', payload?: unknown, status?: number): Promise<any> {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': token },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (status !== undefined) assert.equal(response.status, status, JSON.stringify(data));
  else assert.ok(response.ok, JSON.stringify(data));
  return data;
}
const project = (await api('/api/projects', 'POST', { path: directory })).project;
const session = (await api('/api/sessions', 'POST', { projectId: project.id })).session;
const attachment = (
  await api(`/api/sessions/${session.id}/attachments`, 'POST', {
    name: 'context.md',
    contentBase64: Buffer.from(attachmentMarker).toString('base64'),
  })
).attachment;
const active = (status: string) =>
  ['queued', 'running', 'awaiting_permission', 'stopping'].includes(status);
interface Detail {
  run: Run;
  permissions: Permission[];
  tools: ToolCall[];
  artifacts: Artifact[];
  events: { type: string; payload: Record<string, unknown> }[];
}
async function start(
  text: string,
  mode: 'readonly' | 'edit',
  attachmentIds: string[] = [],
): Promise<Run> {
  if (++queryCount > 6) throw new Error('LIVE_SUITE_QUERY_LIMIT');
  const run: Run = (
    await api(`/api/sessions/${session.id}/messages`, 'POST', {
      text,
      mode,
      attachmentIds,
      contextPaths: [],
      idempotencyKey: randomUUID(),
    })
  ).run;
  currentRunId = run.id;
  return run;
}
async function wait(
  run: Run,
  decide?: (permission: Permission) => Promise<void>,
  onPoll?: (detail: Detail) => Promise<void>,
): Promise<Detail> {
  const deadline = Date.now() + 180000;
  const handled = new Set<string>();
  while (Date.now() < deadline) {
    const detail: Detail = await api('/api/runs/' + run.id);
    for (const permission of detail.permissions.filter(
      (p) => p.status === 'pending' && !handled.has(p.id),
    )) {
      handled.add(permission.id);
      assert.ok(decide, 'Unexpected permission');
      await decide(permission);
    }
    await onPoll?.(detail);
    if (!active(detail.run.status)) {
      receipts.push(detail);
      await save();
      return detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await api(`/api/runs/${run.id}/stop`, 'POST', {});
  throw new Error('LIVE_SUITE_TIMEOUT');
}
async function answer(run: Run): Promise<string> {
  const snapshot = await api(`/api/sessions/${session.id}`);
  return snapshot.messages
    .filter((m: Message) => m.runId === run.id && m.role === 'assistant')
    .map((m: Message) => m.text)
    .join('\n');
}
async function save() {
  await writeFile(
    join(evidence, 'live-results.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        source: 'real application HTTP + SDK + Shunt',
        base,
        config: bootstrap.config,
        directory,
        sessionId: session.id,
        projectId: project.id,
        queryCount,
        receipts,
      },
      null,
      2,
    ) + '\n',
  );
}
const allow = async (p: Permission) => {
  if (p.path)
    assert.ok(
      resolve(directory, p.path).startsWith(directory + '/'),
      'Permission escaped the fixture',
    );
  await api(`/api/permissions/${p.id}/decision`, 'POST', { decision: 'allow', version: p.version });
};
try {
  if (process.argv.includes('--final-tools')) {
    console.log('START final-controlled-tools');
    const run = await start(
      'Use list_files on the project root, then update_plan with one in_progress step. Create alpha.txt with exactly ALPHA and beta.txt with exactly BETA using write_file; you may request them in parallel, each needs separate approval. Publish final-tools.md with the actual results and mark the plan completed. Do not use commands or change any other files.',
      'edit',
    );
    const detail = await wait(run, allow);
    assert.equal(detail.run.status, 'completed');
    assert.equal(await readFile(join(directory, 'alpha.txt'), 'utf8'), 'ALPHA');
    assert.equal(await readFile(join(directory, 'beta.txt'), 'utf8'), 'BETA');
    assert.equal(detail.permissions.filter((p) => p.status === 'allowed').length, 2);
    assert.equal(new Set(detail.permissions.map((p) => p.toolCallId)).size, 2);
    for (const permission of detail.permissions)
      assert.ok(
        detail.tools.some((t) => t.id === permission.toolCallId && t.status === 'succeeded'),
      );
    assert.ok(
      detail.tools.some((t) => t.name === 'mcp__atelier__list_files' && t.status === 'succeeded'),
    );
    assert.ok(
      detail.run.plan.length > 0 && detail.run.plan.every((step) => step.status === 'completed'),
    );
    assert.ok(detail.artifacts.length > 0);
    console.log('PASS final-controlled-tools');
  } else {
    console.log('START readonly-attachment');
    let run = await start(
      'Use Read to read marker.txt. State its exact marker and the exact marker in the attached document. Do not write files.',
      'readonly',
      [attachment.id],
    );
    let detail = await wait(run);
    assert.equal(detail.run.status, 'completed');
    assert.ok((await answer(run)).includes(marker));
    assert.ok((await answer(run)).includes(attachmentMarker));
    assert.ok(detail.tools.some((t) => t.name === 'Read' && t.status === 'succeeded'));
    console.log('PASS readonly-attachment');

    console.log('START session-resume');
    run = await start(
      'Without using any tools, repeat the exact marker you read from marker.txt in the preceding turn.',
      'readonly',
    );
    detail = await wait(run);
    assert.equal(detail.run.status, 'completed');
    assert.ok((await answer(run)).includes(marker));
    assert.ok(
      detail.events.some((e) => e.type === 'sdk.initialized' && e.payload.resumed === true),
    );
    console.log('PASS session-resume');

    console.log('START approved-files-plan-artifact');
    run = await start(
      'This is a controlled test. Use update_plan to record your actual steps. Read note.txt; use edit_file to replace ORIGINAL with APPROVED, preserving its newline. Use write_file to create scratch.txt containing TEMP, then use delete_file to delete scratch.txt. Each file operation needs separate user approval; wait for it. Publish a real document suite-report.md summarizing the actual operations via publish_artifact, and mark your plan complete. Do not run commands or touch other files.',
      'edit',
    );
    detail = await wait(run, allow);
    assert.equal(detail.run.status, 'completed');
    assert.equal(await readFile(join(directory, 'note.txt'), 'utf8'), 'APPROVED\n');
    await assert.rejects(readFile(join(directory, 'scratch.txt')));
    for (const kind of ['edit', 'write', 'delete'])
      assert.ok(
        detail.permissions.some((p) => p.kind === kind && p.status === 'allowed'),
        kind,
      );
    assert.ok(
      detail.run.plan.length > 0 && detail.run.plan.every((step) => step.status === 'completed'),
    );
    assert.ok(detail.artifacts.length > 0);
    const artifact = detail.artifacts[0]!;
    const preview = await api(`/api/artifacts/${artifact.id}/content`);
    const download = await (await fetch(base + `/api/artifacts/${artifact.id}/download`)).text();
    assert.equal(download, preview.text);
    console.log('PASS approved-files-plan-artifact');

    console.log('START denied-delete');
    run = await start(
      'Read note.txt, then attempt delete_file exactly once to delete note.txt. This is a denial test. If permission is denied, stop immediately and explain. Do not use any alternative or repeat the operation.',
      'edit',
    );
    detail = await wait(run, async (p) => {
      assert.equal(p.kind, 'delete');
      await api(`/api/permissions/${p.id}/decision`, 'POST', {
        decision: 'deny',
        version: p.version,
      });
    });
    assert.equal(detail.run.status, 'completed');
    assert.ok(detail.permissions.some((p) => p.status === 'denied'));
    assert.equal(await readFile(join(directory, 'note.txt'), 'utf8'), 'APPROVED\n');
    console.log('PASS denied-delete');

    console.log('START cancel-pending');
    let canceled: Permission | undefined;
    run = await start(
      'Use write_file exactly once to create must-not-exist.txt containing SHOULD_NOT_APPEAR. Wait for approval.',
      'edit',
    );
    detail = await wait(run, async (p) => {
      canceled = p;
      await api(`/api/runs/${run.id}/stop`, 'POST', {});
    });
    assert.equal(detail.run.status, 'stopped');
    assert.ok(canceled);
    await assert.rejects(readFile(join(directory, 'must-not-exist.txt')));
    await api(
      `/api/permissions/${canceled.id}/decision`,
      'POST',
      { decision: 'allow', version: canceled.version },
      409,
    );
    assert.ok(detail.events.some((e) => e.type === 'process.exited'));
    console.log('PASS cancel-pending');

    console.log('START command-stop');
    let stopped = false;
    run = await start(
      'Call run_command exactly once with this exact command: printf started > heartbeat.txt; sleep 20; printf late > after-command.txt . The final period is punctuation, not part of the command. Use the reason "verify command cancellation". Do not use file tools or other commands. Wait for approval.',
      'edit',
    );
    detail = await wait(
      run,
      async (p) => {
        assert.equal(p.kind, 'command');
        assert.equal(
          p.command,
          'printf started > heartbeat.txt; sleep 20; printf late > after-command.txt',
        );
        await allow(p);
      },
      async (state) => {
        if (stopped || !active(state.run.status)) return;
        try {
          if ((await readFile(join(directory, 'heartbeat.txt'), 'utf8')) === 'started') {
            stopped = true;
            await api(`/api/runs/${run.id}/stop`, 'POST', {});
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      },
    );
    assert.ok(stopped);
    assert.equal(detail.run.status, 'stopped');
    await assert.rejects(readFile(join(directory, 'after-command.txt')));
    assert.ok(detail.events.some((e) => e.type === 'process.exited'));
    console.log('PASS command-stop');
  }
  await save();
  await writeFile(
    join(evidence, 'verdict.json'),
    JSON.stringify(
      {
        status: 'PASS',
        scenarios: process.argv.includes('--final-tools') ? 1 : 6,
        queries: queryCount,
        directory,
        sessionId: session.id,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`EVIDENCE ${evidence}`);
} catch (error) {
  if (currentRunId) await api(`/api/runs/${currentRunId}/stop`, 'POST', {}).catch(() => {});
  await save();
  await writeFile(
    join(evidence, 'verdict.json'),
    JSON.stringify(
      {
        status: 'FAIL',
        queries: queryCount,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ) + '\n',
  );
  console.error(error);
  process.exitCode = 1;
}
