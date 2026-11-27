/**
 * @file 验证安全边界、HTTP 路径校验、文件检索过滤与命令输出截断。
 * @implementation 覆盖协议相对路径与非法编码、硬链接过滤、嵌套凭据遮蔽以及多字节 UTF-8 截断。
 * @updated 2026-11-27T12:00:00-06:00
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandsAvailable, runCommand } from '../server/commands.js';
import { findProjectFiles, listProjectFiles } from '../server/files.js';
import { createRequestHandler } from '../server/http/request-handler.js';

function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(text) as Record<string, unknown>,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('HTTP handler rejects protocol-relative paths and malformed percent-encoding with 400', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-http-boundary-'));
  const server = createServer(
    createRequestHandler({
      root,
      csrfToken: 'test-token',
      isShuttingDown: () => false,
      routes: [
        (ctx) => {
          ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          ctx.res.end(JSON.stringify({ parts: ctx.parts }));
          return true;
        },
      ],
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const spoofed = await rawGet(address.port, '//evil.example/api/bootstrap', {
      origin: 'http://evil.example',
    });
    assert.equal(spoofed.status, 403);

    const protocolRelative = await rawGet(address.port, '//evil.example/api/bootstrap');
    assert.equal(protocolRelative.status, 400);

    const malformed = await rawGet(address.port, '/api/sessions/%E0%A4%A');
    assert.equal(malformed.status, 400);

    const valid = await rawGet(address.port, '/api/sessions/ok%20id');
    assert.equal(valid.status, 200);
    assert.deepEqual(valid.body, { parts: ['api', 'sessions', 'ok id'] });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('findProjectFiles and listProjectFiles skip multi-hardlink files', async () => {
  const project = await mkdtemp(join(tmpdir(), 'atelier-files-hardlink-'));
  try {
    await mkdir(join(project, 'nested'));
    await writeFile(join(project, 'normal.txt'), 'ok');
    await writeFile(join(project, 'nested', 'good.txt'), 'ok');
    await writeFile(join(project, 'linked-a.txt'), 'hardlink');
    await link(join(project, 'linked-a.txt'), join(project, 'linked-b.txt'));
    await writeFile(join(project, 'nested', 'hard-a.txt'), 'hardlink');
    await link(join(project, 'nested', 'hard-a.txt'), join(project, 'nested', 'hard-b.txt'));

    const all = await findProjectFiles(project, '');
    const allPaths = all.items.map((item) => item.path);
    assert.ok(allPaths.includes('normal.txt'));
    assert.ok(allPaths.includes('nested/good.txt'));
    assert.ok(!allPaths.includes('linked-a.txt'));
    assert.ok(!allPaths.includes('linked-b.txt'));
    assert.ok(!allPaths.includes('nested/hard-a.txt'));
    assert.ok(!allPaths.includes('nested/hard-b.txt'));

    const listed = await listProjectFiles(project, '');
    const listedNames = listed.items.map((item) => item.name);
    assert.ok(listedNames.includes('normal.txt'));
    assert.ok(!listedNames.includes('linked-a.txt'));
    assert.ok(!listedNames.includes('linked-b.txt'));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('isolated commands mask nested credentials and truncate multibyte UTF-8 cleanly', async (t) => {
  if (!commandsAvailable()) {
    t.skip('bubblewrap is unavailable on this machine');
    return;
  }
  const project = await mkdtemp(join(tmpdir(), 'atelier-cmd-boundary-'));
  try {
    await mkdir(join(project, 'sub'));
    await mkdir(join(project, 'certs'));
    await mkdir(join(project, 'deploy'));
    await writeFile(join(project, 'sub', '.env.local'), 'SUB_SECRET');
    await writeFile(join(project, 'certs', 'server.key'), 'KEY_SECRET');
    await writeFile(join(project, 'deploy', 'id_rsa'), 'SSH_SECRET');
    await writeFile(join(project, 'sub', 'public.txt'), 'PUBLIC_OK');

    const masked = await runCommand(
      project,
      'cat sub/.env.local certs/server.key deploy/id_rsa sub/public.txt',
      new AbortController().signal,
    );
    assert.equal(masked.code, 0);
    assert.equal(masked.output, 'PUBLIC_OK');

    const truncated = await runCommand(
      project,
      'node -e "process.stdout.write(\'中\'.repeat(25000))"',
      new AbortController().signal,
    );
    assert.equal(truncated.code, 0);
    assert.equal(truncated.truncated, true);
    assert.ok(truncated.output.includes('[输出超过 64 KiB，已截断]'));
    assert.ok(!truncated.output.includes('\uFFFD'));
    assert.ok(truncated.output.startsWith('中'.repeat(100)));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
