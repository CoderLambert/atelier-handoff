/**
 * @file 验证终端发行文件与跨平台候选的依赖边界。
 * @implementation 使用隔离包目录检查 Linux native 选择、非法输入拒绝及候选清单一致性。
 * @updated 2026-11-26T01:30:00+08:00
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const resources = () =>
  import('../scripts/linux/terminal-resources.mjs').catch((error: unknown) => {
    assert.fail(`Terminal packaging support is unavailable: ${String(error)}`);
  });

function linuxBinding(): Buffer {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(62, 18);
  return header;
}

async function fixture(files: Record<string, string | Buffer>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-terminal-package-'));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return directory;
}

test('Linux PTY selection excludes foreign prebuilds, debug, tests and install scripts', async () => {
  const directory = await fixture({
    'package.json': '{"name":"node-pty","version":"1.1.0"}',
    LICENSE: 'fixture license',
    'lib/index.js': 'exports.spawn = () => {};',
    'lib/unixTerminal.js': 'require("../build/Release/pty.node");',
    'lib/shared/conout.js': 'exports.value = 1;',
    'lib/unixTerminal.test.js': 'throw new Error("test only");',
    'lib/index.js.map': '{}',
    'build/Release/pty.node': linuxBinding(),
    'build/Debug/pty.node': 'debug',
    'build/Release/spawn-helper': 'macOS only',
    'prebuilds/darwin-arm64/pty.node': 'foreign',
    'prebuilds/win32-x64/conpty.node': 'foreign',
    'scripts/install.js': 'throw new Error("install only");',
    'src/index.ts': '// source only',
  });
  try {
    const { selectPtyPackageFiles } = await resources();
    assert.deepEqual(await selectPtyPackageFiles(directory), [
      'LICENSE',
      'build/Release/pty.node',
      'lib/index.js',
      'lib/shared/conout.js',
      'lib/unixTerminal.js',
      'package.json',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Linux PTY selection rejects missing native and a binary for another platform', async () => {
  const directory = await fixture({
    'package.json': '{"name":"node-pty","version":"1.1.0"}',
    'lib/index.js': 'exports.spawn = () => {};',
  });
  try {
    const { selectPtyPackageFiles } = await resources();
    await assert.rejects(selectPtyPackageFiles(directory), /native|pty\.node/i);
    await mkdir(join(directory, 'build/Release'), { recursive: true });
    await writeFile(join(directory, 'build/Release/pty.node'), Buffer.alloc(64, 0x4d));
    await assert.rejects(selectPtyPackageFiles(directory), /ELF.*x64|Linux x64/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Linux PTY selection rejects a runtime symlink outside its package', async () => {
  const directory = await fixture({
    'package.json': '{"name":"node-pty","version":"1.1.0"}',
    'lib/index.js': 'exports.spawn = () => {};',
    'build/Release/pty.node': linuxBinding(),
  });
  try {
    await symlink('/tmp', join(directory, 'lib/escape'));
    const { selectPtyPackageFiles } = await resources();
    await assert.rejects(selectPtyPackageFiles(directory), /symlink/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PTY inventory requires exactly the selected Linux binding', async () => {
  const { assertPtyNativeFiles } = await resources();
  assert.doesNotThrow(() => assertPtyNativeFiles(['package.json', 'build/Release/pty.node']));
  for (const files of [
    ['package.json'],
    ['build/Release/pty.node', 'build/Release/pty.node'],
    ['build/Release/pty.node', 'prebuilds/darwin-arm64/pty.node'],
    ['build/Release/pty.node', 'prebuilds/win32-x64/conpty.dll'],
  ]) {
    assert.throws(() => assertPtyNativeFiles(files), /exactly.*Linux x64/i);
  }
});

test('smoke permits a recorded terminal shell but rejects changed PID identity or executable', async () => {
  const { allowTerminalShell, installedOrTerminalProcess } =
    await import('../scripts/p1-smoke/terminal.mjs').catch((error: unknown) =>
      assert.fail(`Terminal process ownership support is unavailable: ${String(error)}`),
    );
  const shell = {
    pid: 102,
    parent: 100,
    state: 'S',
    executable: '/usr/bin/bash',
    args: ['/bin/bash'],
    rssKiB: 1200,
    startTicks: '91824',
  };
  const allowed = allowTerminalShell(shell.pid, 100, [shell]);
  assert.equal(installedOrTerminalProcess(shell, [allowed]), true);
  assert.equal(
    installedOrTerminalProcess({ ...shell, executable: '/opt/atelier/atelier' }, []),
    true,
  );
  assert.equal(installedOrTerminalProcess({ ...shell, pid: 103 }, [allowed]), false);
  assert.equal(installedOrTerminalProcess({ ...shell, startTicks: '91825' }, [allowed]), false);
  assert.equal(
    installedOrTerminalProcess({ ...shell, executable: '/usr/bin/python3' }, [allowed]),
    false,
  );
  assert.throws(() => allowTerminalShell(shell.pid, 99, [shell]), /sidecar/i);
  assert.throws(() => allowTerminalShell(999, 100, [shell]), /observed/i);
});

test('preview drops only the PTY runtime tree and all three dependency declarations', async () => {
  const { isPtyRuntimeResource, terminalPreviewMetadata } = await resources();
  const manifest = {
    name: 'fixture-runtime',
    version: '0.2.0',
    type: 'module',
    dependencies: {
      'node-pty': '1.1.0',
      ws: '8.23.0',
      '@xterm/headless': '6.0.0',
      '@xterm/addon-serialize': '0.14.0',
    },
  };
  const release = {
    runtimeDependencyRoots: ['node-pty', 'ws', '@xterm/headless', '@xterm/addon-serialize'],
    runtimeDependencies: [
      {
        name: 'node-pty',
        version: '1.1.0',
        path: 'node_modules/node-pty',
        files: ['package.json', 'build/Release/pty.node'],
      },
      {
        name: 'ws',
        version: '8.23.0',
        path: 'node_modules/ws',
        files: ['package.json', 'wrapper.mjs'],
      },
      {
        name: '@xterm/headless',
        version: '6.0.0',
        path: 'node_modules/@xterm/headless',
        files: ['package.json', 'lib-headless/xterm-headless.js'],
      },
      {
        name: '@xterm/addon-serialize',
        version: '0.14.0',
        path: 'node_modules/@xterm/addon-serialize',
        files: ['package.json', 'lib/addon-serialize.js'],
      },
      {
        name: 'node-addon-api',
        version: '7.1.1',
        path: 'node_modules/node-addon-api',
        files: ['package.json', 'index.js'],
      },
    ],
  };
  const preview = terminalPreviewMetadata(manifest, release);
  assert.deepEqual(preview.runtimePackage, {
    name: 'fixture-runtime',
    version: '0.2.0',
    type: 'module',
    dependencies: { ws: '8.23.0', '@xterm/headless': '6.0.0', '@xterm/addon-serialize': '0.14.0' },
  });
  assert.deepEqual(preview.runtimeDependencyRoots, [
    'ws',
    '@xterm/headless',
    '@xterm/addon-serialize',
  ]);
  assert.deepEqual(
    preview.runtimeDependencies.map((item) => item.name),
    ['ws', '@xterm/headless', '@xterm/addon-serialize', 'node-addon-api'],
  );
  assert.deepEqual(preview.terminal, { supported: false, reason: 'platform-unsupported' });
  assert.equal(manifest.dependencies['node-pty'], '1.1.0', 'Source manifest must not be mutated');
  assert.equal(isPtyRuntimeResource('resources/runtime/node_modules/node-pty/lib/index.js'), true);
  assert.equal(
    isPtyRuntimeResource('resources/runtime/node_modules/node-pty/build/Release/pty.node'),
    true,
  );
  assert.equal(
    isPtyRuntimeResource('resources/runtime/node_modules/node-pty-extra/index.js'),
    false,
  );
  assert.equal(isPtyRuntimeResource('resources/licenses/node_modules/node-pty/LICENSE'), false);
});

test(
  'compiled Terminal probe loads the staged runtime and observes PTY, screen, WS and exit',
  {
    skip: process.platform !== 'linux' || process.arch !== 'x64',
    timeout: 30_000,
  },
  async (context) => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const source = await readFile(join(root, 'scripts/linux/terminal-probe.mts'), 'utf8').catch(
      () => assert.fail('A staged Terminal probe is required for native release verification'),
    );
    const runtime = await mkdtemp(join(tmpdir(), 'atelier-terminal-staged-'));
    try {
      const { selectPtyPackageFiles, terminalProbeResultSchema } = await resources();
      await writeFile(join(runtime, 'package.json'), '{"type":"module"}');
      for (const name of ['ws', '@xterm/headless', '@xterm/addon-serialize']) {
        await cp(join(root, 'node_modules', name), join(runtime, 'node_modules', name), {
          recursive: true,
        });
      }
      const installed = join(root, 'node_modules/node-pty');
      for (const name of await selectPtyPackageFiles(installed)) {
        const target = join(runtime, 'node_modules/node-pty', name);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(installed, name), target);
      }
      const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'node24' });
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', compiled.code], {
        cwd: runtime,
        timeout: 20_000,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        maxBuffer: 1024 * 1024,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const evidence = terminalProbeResultSchema.parse(JSON.parse(result.stdout) as unknown);
      context.diagnostic(`Isolated compiled runtime probe: ${JSON.stringify(evidence)}`);
      assert.equal(evidence.node, process.versions.node);
      assert.deepEqual(evidence.pty, { tty: true, cwd: true, cols: 91, rows: 37, exitCode: 0 });
      assert.equal(evidence.headlessSnapshot, true);
      assert.equal(evidence.websocketEcho, true);
    } finally {
      await rm(runtime, { recursive: true, force: true });
    }
  },
);
