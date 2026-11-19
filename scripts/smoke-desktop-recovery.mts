/**
 * @file 验证 Linux 安装件的运行时监督和故障恢复。
 * @implementation 使用隔离数据、真实 SDK 与回环服务，在待审批和运行中注入退出。
 * @updated 2026-11-20T02:00+08:00
 */
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { desktopHostVersion } from '../shared/desktop-host.js';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { array, record, string, until } from './p1-smoke/contracts.mjs';
import { listen, model, streamFixtureApproval } from './p1-smoke/fixtures.mjs';

const binary = process.argv[2];
assert.ok(binary, 'Usage: tsx scripts/smoke-desktop-recovery.mts /installed/atelier');
const executablePath = resolve(binary);
const args = ['--ozone-platform=x11'];
const root = await mkdtemp(join(tmpdir(), 'atelier-recovery-smoke-'));
const data = join(root, 'data');
let application: ElectronApplication | undefined;
let requests = 0;
let hold = false;
const gateway = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.end('{}');
    return;
  }
  if (
    req.method !== 'POST' ||
    new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/v1/messages'
  ) {
    res.writeHead(404).end();
    return;
  }
  req.resume();
  req.once('end', () => {
    requests++;
    if (!hold) streamFixtureApproval(res);
  });
});

async function request(
  page: Page,
  route: string,
  expected: number,
  post?: Record<string, unknown>,
  token = '',
) {
  const response = await page.evaluate(
    async ({ route, post, token }) => {
      const result = await fetch(
        route,
        post
          ? {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-atelier-token': token },
              body: JSON.stringify(post),
            }
          : undefined,
      );
      return { status: result.status, body: (await result.json()) as unknown };
    },
    { route, post, token },
  );
  assert.equal(response.status, expected, route);
  return record(response.body, route);
}

async function ownerPid() {
  const pid = Number(await readFile(join(data, 'server.lock'), 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  return pid;
}

async function exited(pid: number) {
  await until(
    async () =>
      await access(`/proc/${pid}`).then(
        () => undefined,
        () => true,
      ),
    5000,
    `runtime exit ${pid}`,
  );
}

try {
  const gatewayUrl = await listen(gateway);
  const env = {
    ...process.env,
    ATELIER_PORT: '0',
    ATELIER_DATA_DIR: data,
    ATELIER_GATEWAY: gatewayUrl,
    ATELIER_MODEL: model,
    ATELIER_GATEWAY_TOKEN: 'offline-fixture',
  };
  async function launch() {
    application = await _electron.launch({ executablePath, args, env, timeout: 15_000 });
    const page = await application.firstWindow();
    await page.waitForURL('http://127.0.0.1:*/');
    return { page, app: application };
  }
  const { app, page } = await launch();
  const initialPid = await ownerPid();
  const duplicate = spawn(executablePath, args, { env, stdio: 'ignore' });
  assert.deepEqual(await once(duplicate, 'exit'), [0, null]);
  assert.equal(await ownerPid(), initialPid);
  const origin = new URL(page.url()).origin;
  const runtime = join(dirname(executablePath), 'resources/runtime');
  async function probeRuntime(dataDir: string, port: string, version: number, expected?: string) {
    const child = fork(join(runtime, 'server/main.js'), [], {
      execPath: join(runtime, 'bin/node'),
      execArgv: [],
      env: { ...env, ATELIER_DESKTOP_BROWSER: '1', ATELIER_PORT: port, ATELIER_DATA_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const closed = once(child, 'close');
    let reply: Record<string, unknown> | undefined;
    child.on('message', (value) => {
      reply = record(value);
    });
    const generation = randomUUID();
    child.send({
      type: 'atelier-host:hello',
      generation,
      protocolVersion: version,
      pairing: 'a'.repeat(64),
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      assert.deepEqual(await closed, [1, null]);
      assert.equal(reply?.code, expected);
      if (expected) assert.equal(reply?.generation, generation);
    } finally {
      clearTimeout(deadline);
    }
  }
  await probeRuntime(data, '0', desktopHostVersion, 'DATA_LOCKED');
  await probeRuntime(
    join(root, 'different-data'),
    new URL(origin).port,
    desktopHostVersion,
    'PORT_IN_USE',
  );
  await probeRuntime(join(root, 'old-host'), '0', desktopHostVersion - 1);
  assert.equal((await fetch(origin + '/api/bootstrap')).status, 403);
  const boot = await request(page, '/api/bootstrap', 200);
  const token = string(boot.csrfToken);
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  const project = record(
    (await request(page, '/api/projects', 201, { path: projectPath }, token)).project,
  );
  const session = record(
    (await request(page, '/api/sessions', 201, { projectId: project.id }, token)).session,
  );
  const route = `/api/sessions/${string(session.id)}`;
  const pending = {
    text: 'Wait for approval before writing the test file.',
    mode: 'edit',
    idempotencyKey: randomUUID(),
  };
  const first = record((await request(page, route + '/messages', 202, pending, token)).run);
  const permission = await until(
    async () => {
      const state = await request(page, route, 200);
      return array(state.permissions)
        .map((item) => record(item))
        .find((item) => item.status === 'pending');
    },
    30_000,
    'real SDK requests approval for the fixture write',
  );

  // Only the native dialog's reply is substituted; Electron, the window, the
  // SDK tool, the crashed sidecar and rollback to the same data are real.
  const notice = await app.evaluate(({ dialog }) => {
    const seen: string[] = [];
    dialog.showMessageBox = async (...params: unknown[]) => {
      const options = params.at(-1) as { message: string; buttons?: string[] };
      seen.push(`${options.message}|${options.buttons?.[0]}`);
      return { response: 0, checkboxChecked: false };
    };
    return seen.length;
  });
  assert.equal(notice, 0);
  process.kill(initialPid, 'SIGKILL');
  await exited(initialPid);
  await page.waitForURL((url) => url.origin !== origin && url.hostname === '127.0.0.1');
  const restored = await request(page, route, 200);
  assert.equal(record(restored.session).id, session.id);
  assert.ok(
    array(restored.runs)
      .map((item) => record(item))
      .some((run) => run.id === first.id && run.status === 'interrupted'),
  );
  assert.equal(record(array(restored.permissions)[0]).status, 'canceled');
  const nextToken = string((await request(page, '/api/bootstrap', 200)).csrfToken);
  assert.notEqual(nextToken, token);
  const decision = await request(
    page,
    `/api/permissions/${string(permission.id)}/decision`,
    409,
    { decision: 'allow', version: permission.version },
    nextToken,
  );
  assert.equal(record(decision.error).code, 'PERMISSION_EXPIRED');
  await assert.rejects(access(join(projectPath, 'approval-fixture.txt')), { code: 'ENOENT' });
  const duplicateRun = await request(page, route + '/messages', 202, pending, nextToken);
  assert.equal(record(duplicateRun.run).id, first.id);
  assert.equal(requests, 1, 'Restart and retransmit must not start the previous operation again');

  hold = true;
  const second = record(
    (
      await request(
        page,
        route + '/messages',
        202,
        { ...pending, text: 'Wait for the shutdown test.', idempotencyKey: randomUUID() },
        nextToken,
      )
    ).run,
  );
  await until(
    async () => {
      if (requests >= 2) return true;
      const state = await request(page, route, 200);
      const run = array(state.runs)
        .map((item) => record(item))
        .find((item) => item.id === second.id);
      if (run && ['failed', 'stopped', 'interrupted', 'completed'].includes(string(run.status)))
        throw new Error(
          `Shutdown fixture exited before calling its gateway: ${String(run.reason)}`,
        );
      return undefined;
    },
    30_000,
    'running SDK request',
  );
  const activePid = await ownerPid();
  const stoppedAt = performance.now();
  await app.close();
  application = undefined;
  await exited(activePid);
  const shutdownMs = Math.round(performance.now() - stoppedAt);
  assert.ok(shutdownMs <= 3000, `Running SDK graceful shutdown took ${shutdownMs} ms`);

  const reopened = await launch();
  const finalState = await request(reopened.page, route, 200);
  assert.ok(
    array(finalState.runs)
      .map((item) => record(item))
      .some(
        (run) =>
          run.id === second.id &&
          run.status === 'interrupted' &&
          run.reason === '服务关闭，运行中断。',
      ),
  );
  const reopenedPid = await ownerPid();
  await reopened.app.close();
  application = undefined;
  await exited(reopenedPid);
  console.log(
    JSON.stringify(
      {
        duplicateSingleWriter: true,
        unpairedDenied: true,
        realSdk: true,
        paidCalls: 0,
        crashDuringApproval: true,
        approvalReplayed: false,
        gracefulStopDuringRun: true,
        shutdownMs,
        runtimeProcessesExited: 3,
        recoveryDialogReply: 'test substitute',
      },
      null,
      2,
    ),
  );
} finally {
  await application?.close().catch(() => {});
  gateway.closeAllConnections();
  await new Promise<void>((done) => gateway.close(() => done()));
  await rm(root, { recursive: true, force: true });
}
