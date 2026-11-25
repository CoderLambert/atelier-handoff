/**
 * @file 验证人工 PTY 的环境和真实 shell 生命周期。
 * @implementation 检查内部凭据移除、用户 PATH 保留及真实 PTY 的 Unicode 输出与退出事件。
 * @updated 2026-11-26T01:00:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './fixtures/terminal-process-double.js';
import {
  createTerminalProcessProvider,
  terminalEnvironment,
  type TerminalProcess,
  type TerminalProcessExit,
} from '../server/modules/terminal/process.js';

test('terminal environment removes internal credentials and only the installed runtime PATH prefix', () => {
  const env = terminalEnvironment(
    {
      PATH: '/app/bin:/usr/bin:/bin',
      HOME: '/home/person',
      LANG: 'C.UTF-8',
      ATELIER_MANAGED_GATEWAY_TOKEN: 'internal',
      SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR: '/secret',
      NODE_CHANNEL_FD: '3',
      NODE_OPTIONS: '--inspect',
      ANTHROPIC_API_KEY: 'user-key',
    },
    '/app/bin',
  );
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/home/person');
  assert.equal(env.ANTHROPIC_API_KEY, 'user-key');
  assert.equal(env.ATELIER_MANAGED_GATEWAY_TOKEN, undefined);
  assert.equal(env.SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR, undefined);
  assert.equal(env.NODE_CHANNEL_FD, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(
    terminalEnvironment({ PATH: '/usr/bin:/app/bin:/bin' }, '/app/bin').PATH,
    '/usr/bin:/app/bin:/bin',
  );
});

test(
  'real PTY uses its supplied cwd and delivers Unicode before the observed exit',
  { skip: process.platform !== 'linux', timeout: 10000 },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'atelier-pty-'));
    try {
      const provider = createTerminalProcessProvider({
        shell: '/bin/sh',
        environment: { PATH: '/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8' },
      });
      const spawn = await provider.prepare();
      let output = '';
      let finish: (value: TerminalProcessExit) => void = () => {};
      const exited = new Promise<TerminalProcessExit>((resolve) => {
        finish = resolve;
      });
      const process = spawn({
        cwd,
        cols: 80,
        rows: 24,
        onData: (value) => {
          output += value;
        },
        onExit: finish,
      });
      process.write('printf \'\\nPTY:%s:世界\\n\' "$PWD"; exit 7\n');
      assert.deepEqual(await exited, { exitCode: 7, signal: null });
      assert.ok(output.includes('PTY:' + cwd + ':世界'));
      process.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  'real PTY Ctrl-C interrupts a foreground job and leaves the interactive shell usable',
  { skip: process.platform !== 'linux', timeout: 10000 },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'atelier-pty-interrupt-'));
    let terminal: TerminalProcess | undefined;
    let exited: TerminalProcessExit | undefined;
    try {
      const spawn = await createTerminalProcessProvider({
        shell: '/bin/sh',
        environment: { PATH: '/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8' },
      }).prepare();
      let output = '';
      terminal = spawn({
        cwd,
        cols: 80,
        rows: 24,
        onData: (value) => {
          output += value;
        },
        onExit: (value) => {
          exited = value;
        },
      });
      terminal.write("printf '\\nWAIT_%s\\n' READY; sleep 30\n");
      await until(() => output.includes('\r\nWAIT_READY\r\n'));
      terminal.write('\u0003');
      terminal.write("printf '\\nAFTER_%s\\n' INTERRUPT; exit 0\n");
      await until(() => exited !== undefined);
      assert.ok(output.includes('\r\nAFTER_INTERRUPT\r\n'));
      assert.deepEqual(exited, { exitCode: 0, signal: null });
      terminal.dispose();
    } finally {
      if (terminal && !exited) {
        terminal.kill('SIGKILL');
        await until(() => exited !== undefined);
        terminal.dispose();
      }
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
