/**
 * @file 验证开发桌面命令可以跟随 Git 拉取重新构建。
 * @implementation 通过临时仓库和桌面替身验证 npm 入口、空闲后重启、端口继承、构建失败及用户退出。
 * @updated 2026-12-08T12:00:00+00:00
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

test(
  'desktop rebuilds on checkout changes and restarts after the window is idle',
  { timeout: 40_000 },
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'atelier-desktop-git-'));
    const upstream = join(fixture, 'upstream');
    const checkout = join(fixture, 'checkout');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const commit = async (revision: string) => {
      await writeFile(join(upstream, 'revision'), revision);
      git(upstream, 'add', 'revision');
      git(
        upstream,
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'user.name=Fixture',
        'commit',
        '-m',
        revision,
      );
    };
    const reader = async (name: string) => readFile(join(checkout, name), 'utf8').catch(() => '');
    let output = '';
    async function until(condition: () => Promise<boolean>, label: string) {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await condition()) return;
        await pause(100);
      }
      assert.fail(`${label}\n${output}`);
    }
    const equalFile = (name: string, contents: string) => async () =>
      (await reader(name)) === contents;

    let desktop: ReturnType<typeof spawn> | undefined;
    let exited: ReturnType<typeof once> | undefined;
    try {
      await mkdir(upstream);
      git(upstream, 'init', '-b', 'main');
      await commit('initial');
      git(fixture, 'clone', upstream, checkout);
      await mkdir(join(checkout, 'scripts'));
      await mkdir(join(checkout, 'node_modules/electron'), { recursive: true });
      await cp(
        new URL('../scripts/run-desktop.mts', import.meta.url),
        join(checkout, 'scripts/run-desktop.mts'),
      );
      await mkdir(join(checkout, 'shared'));
      await mkdir(join(checkout, 'dist/desktop'), { recursive: true });
      await cp(
        new URL('../shared/desktop-development-restart.ts', import.meta.url),
        join(checkout, 'shared/desktop-development-restart.ts'),
      );
      await symlink(
        fileURLToPath(new URL('../node_modules/zod', import.meta.url)),
        join(checkout, 'node_modules/zod'),
        'junction',
      );
      await writeFile(
        join(checkout, 'node_modules/electron/index.js'),
        'module.exports = process.execPath;',
      );
      const { scripts } = z
        .object({ scripts: z.object({ desktop: z.string(), 'desktop:build': z.string() }) })
        .parse(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')));
      await symlink(
        fileURLToPath(new URL('../node_modules/tsx', import.meta.url)),
        join(checkout, 'node_modules/tsx'),
        'junction',
      );
      await writeFile(
        join(checkout, 'package.json'),
        JSON.stringify({
          scripts: {
            ...scripts,
            'check:desktop': 'node -e ""',
            build: 'node build.cjs',
            'build:desktop': 'node -e ""',
          },
        }),
      );
      await writeFile(
        join(checkout, 'build.cjs'),
        `
      const { appendFileSync, readFileSync } = require('node:fs');
      const revision = readFileSync('revision', 'utf8');
      appendFileSync('builds', revision + '\\n');
      if (revision === 'broken') process.exitCode = 1;
    `,
      );
      await writeFile(
        join(checkout, 'dist/desktop/main.mjs'),
        `
      import { appendFileSync, existsSync } from 'node:fs';
      if (process.env.ATELIER_DEV_LAUNCH !== '1') throw new Error('Missing development launch mode');
      appendFileSync('windows', JSON.stringify(['dist/desktop/main.mjs', ...process.argv.slice(2)]) + '\\n');
      appendFileSync('ports', (process.env.ATELIER_PORT ?? 'initial') + '\\n');
      process.on('message', (message) => {
        if (message.type !== 'atelier-dev:restart' || existsSync('busy')) return;
        process.send({type:'atelier-dev:restarting', port:43210}, () => process.exit(0));
      });
      const timer = setInterval(() => { if (existsSync('quit')) { clearInterval(timer); process.disconnect(); } }, 50);
    `,
      );

      desktop = spawn('npm', ['run', 'desktop', '--', '--fixture-arg'], {
        cwd: checkout,
        shell: process.platform === 'win32',
      });
      exited = once(desktop, 'close');
      desktop.stdout?.on('data', (chunk) => {
        output += String(chunk);
      });
      desktop.stderr?.on('data', (chunk) => {
        output += String(chunk);
      });
      const window = '["dist/desktop/main.mjs","--fixture-arg"]\n';
      await until(equalFile('windows', window), 'Initial window did not start');
      assert.equal(await reader('builds'), 'initial\n');

      await commit('updated');
      git(checkout, 'fetch');
      await pause(2_000);
      assert.equal(await reader('builds'), 'initial\n');
      await writeFile(join(checkout, 'busy'), '');
      git(checkout, 'pull', '--ff-only');
      await until(equalFile('builds', 'initial\nupdated\n'), 'Pull did not trigger a rebuild');
      await pause(2_000);
      assert.equal(await reader('windows'), window);
      await rm(join(checkout, 'busy'));
      await until(
        equalFile('windows', window.repeat(2)),
        'Successful rebuild did not restart Electron',
      );

      await commit('broken');
      git(checkout, 'pull', '--ff-only');
      await until(async () => output.includes('Rebuild failed'), 'Build failure was not reported');
      await pause(2_000);
      assert.equal(await reader('builds'), 'initial\nupdated\nbroken\n');
      assert.equal(await reader('windows'), window.repeat(2));

      await commit('fixed');
      git(checkout, 'pull', '--ff-only');
      await until(
        async () => output.split('Rebuild complete').length === 3,
        'Later rebuild did not recover',
      );
      await until(
        equalFile('builds', 'initial\nupdated\nbroken\nfixed\n'),
        'Later commit did not rebuild',
      );
      await until(equalFile('windows', window.repeat(3)), 'Later rebuild did not restart Electron');
      assert.match(await reader('ports'), /43210\n43210\n$/u);
      await writeFile(join(checkout, 'quit'), '');
      assert.deepEqual(await exited, [0, null]);
    } finally {
      if (desktop?.exitCode === null && desktop.signalCode === null) {
        await writeFile(join(checkout, 'quit'), '');
        await exited;
      }
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
