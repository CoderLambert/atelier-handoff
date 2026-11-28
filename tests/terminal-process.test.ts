/**
 * @file 验证人工 PTY 的环境和真实 shell 生命周期。
 * @implementation 检查环境隔离、Unicode 流与退出，并等待真实前台进程组后验证 Ctrl+C。
 * @updated 2026-11-28T18:03:06+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
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
      const prompt = 'ATELIER_TEST_PROMPT> ';
      terminal.write(
        `PS1='${prompt}'; sh -c 'printf "\\nWAIT_%s:%s\\n" READY "$$"; exec sleep 30'\n`,
      );
      const jobMarker = () => /\r\nWAIT_READY:(\d+)\r\n/u.exec(output)?.[1];
      await until(() => jobMarker() !== undefined);
      const job = jobMarker();
      assert.ok(job);
      await until(() => {
        const stat = readFileSync(`/proc/${job}/stat`, 'utf8');
        const endOfName = stat.lastIndexOf(')');
        // After comm, /proc/<pid>/stat contains state, parent, process group,
        // session, tty and foreground process group, in that order.
        const [, , group, , , foreground] = stat.slice(endOfName + 2).split(' ');
        return stat.slice(0, endOfName).endsWith(' (sleep') && group === foreground;
      });
      const beforeInterrupt = output.length;
      terminal.write('\u0003');
      await until(() => output.slice(beforeInterrupt).includes(prompt));
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
