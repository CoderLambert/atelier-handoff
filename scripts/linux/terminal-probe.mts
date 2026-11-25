/**
 * @file 用目标 Node 验证已暂存终端运行依赖。
 * @implementation 编译后从 runtime 工作目录执行，检查真实 PTY、尺寸、退出、屏幕快照和 WebSocket 回环。
 * @updated 2026-11-26T01:30:00+08:00
 */
// This controller is compiled outside the app and evaluated by the staged Node.
// Its bare imports must resolve only from that runtime, never the source checkout.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node-pty';
import headless from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import WebSocket, { WebSocketServer } from 'ws';

async function bounded<T>(pending: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Terminal probe timed out: ${label}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function probePty() {
  let stty: string | undefined;
  for (const candidate of ['/usr/bin/stty', '/bin/stty']) {
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    ) {
      stty = candidate;
      break;
    }
  }
  assert.ok(stty, 'An absolute stty executable is required to observe PTY resize');
  const directory = await mkdtemp(join(tmpdir(), 'atelier-pty-probe-'));
  let terminal: ReturnType<typeof spawn>;
  try {
    terminal = spawn('/bin/sh', ['-i'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: directory,
      env: { PATH: '/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8', TERM: 'xterm-256color' },
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let output = '';
  let failure: Error | undefined;
  let exitCode: number | undefined;
  const outputListener = terminal.onData((data) => {
    if (Buffer.byteLength(output, 'utf8') + Buffer.byteLength(data, 'utf8') > 64 * 1024) {
      failure = new Error('Terminal probe output exceeded its bounded buffer');
      return;
    }
    output += data;
  });
  let exitListener: ReturnType<typeof terminal.onExit> | undefined;
  const exited = new Promise<number>((resolve) => {
    exitListener = terminal.onExit((event) => {
      exitCode = event.exitCode;
      resolve(event.exitCode);
    });
  });
  const deadline = Date.now() + 8_000;
  async function observe(check: () => boolean, label: string): Promise<void> {
    while (!check()) {
      if (failure) throw failure;
      assert.equal(exitCode, undefined, `PTY exited before ${label}`);
      assert.ok(Date.now() < deadline, `Terminal probe timed out: ${label}`);
      await delay(10);
    }
  }
  try {
    terminal.write(
      "printf '\\nATELIER_TTY='; if test -t 0 && test -t 1; then printf 'yes\\n'; else printf 'no\\n'; fi\n",
    );
    await observe(() => /^ATELIER_TTY=yes\r?$/mu.test(output), 'TTY identity');
    terminal.write('printf \'\\nATELIER_CWD=%s\\n\' "$PWD"\n');
    await observe(() => output.includes(`\nATELIER_CWD=${directory}\r\n`), 'initial directory');
    terminal.resize(91, 37);
    terminal.write(`printf '\\nATELIER_SIZE='; ${stty} size\n`);
    await observe(() => /^ATELIER_SIZE=37 91\r?$/mu.test(output), 'kernel PTY dimensions');
    terminal.write('exit 0\n');
    assert.equal(await bounded(exited, 'PTY exit'), 0);
    return { tty: true, cwd: true, cols: 91, rows: 37, exitCode: 0 } as const;
  } finally {
    if (exitCode === undefined) {
      terminal.kill('SIGKILL');
      await bounded(exited, 'PTY failure cleanup', 2_000);
    }
    outputListener.dispose();
    exitListener?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

async function probeScreen(): Promise<true> {
  const original = new headless.Terminal({
    allowProposedApi: true,
    cols: 91,
    rows: 37,
    scrollback: 10,
  });
  const restored = new headless.Terminal({
    allowProposedApi: true,
    cols: 91,
    rows: 37,
    scrollback: 10,
  });
  const serializer = new SerializeAddon();
  try {
    original.loadAddon(serializer);
    await bounded(
      new Promise<void>((resolve) => original.write('\x1b[31mTerminal 终端 ✓\x1b[0m\r\n', resolve)),
      'headless parse',
    );
    const snapshot = serializer.serialize();
    assert.ok(snapshot.length > 0 && Buffer.byteLength(snapshot) < 64 * 1024);
    await bounded(
      new Promise<void>((resolve) => restored.write(snapshot, resolve)),
      'snapshot restore',
    );
    assert.equal(restored.buffer.active.getLine(0)?.translateToString(true), 'Terminal 终端 ✓');
    assert.equal(restored.buffer.active.cursorX, original.buffer.active.cursorX);
    assert.equal(restored.buffer.active.cursorY, original.buffer.active.cursorY);
    return true;
  } finally {
    original.dispose();
    restored.dispose();
  }
}

async function probeWebSocket(): Promise<true> {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: false,
    maxPayload: 1024,
  });
  let client: WebSocket | undefined;
  server.on('connection', (socket) => {
    socket.once('message', (data) => socket.send(data));
  });
  try {
    await bounded(once(server, 'listening'), 'WebSocket listen');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    client = new WebSocket(`ws://127.0.0.1:${address.port}`, { perMessageDeflate: false });
    await bounded(once(client, 'open'), 'WebSocket connect');
    const received = once(client, 'message');
    client.send('atelier-terminal-probe');
    const [message]: unknown[] = await bounded(received, 'WebSocket echo');
    assert.ok(Buffer.isBuffer(message));
    assert.equal(message.toString('utf8'), 'atelier-terminal-probe');
    return true;
  } finally {
    client?.terminate();
    for (const socket of server.clients) socket.terminate();
    await bounded(
      new Promise<void>((resolve) => server.close(() => resolve())),
      'WebSocket cleanup',
    );
  }
}

async function main(): Promise<void> {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  const pty = await probePty();
  const headlessSnapshot = await probeScreen();
  const websocketEcho = await probeWebSocket();
  console.log(
    JSON.stringify({
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      napi: process.versions.napi,
      modules: process.versions.modules,
      pty,
      headlessSnapshot,
      websocketEcho,
    }),
  );
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
