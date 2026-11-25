/**
 * @file 验证固定 RTK 工件、启动器隔离和桌面到运行时的可信资源传递。
 * @implementation 临时目录校验归档字节、启动器作用域与私有启动参数；默认使用 Node 替身，显式启用真实工件时核对 Git、bypass 与应用私有统计。
 * @updated 2026-11-26T01:56:41+08:00
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { z } from 'zod';
import { build } from 'esbuild';
import { clearRtkEnvironment, rtkLauncher, rtkRelease } from '../shared/builtin-rtk.js';
import { RuntimeSupervisor } from '../desktop/host/runtime.mjs';
import {
  prepareRtkRelease,
  rtkArchiveCachePath,
  stageRtkRelease,
  verifyRtkArchive,
} from '../scripts/linux/rtk.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const licenseName = `rtk-oss-${rtkRelease.version}-LICENSE.txt`;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function temporary(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'atelier rtk packaging '));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function archive(args: string[]): void {
  const result = spawnSync('tar', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
}

test('bundled RTK keeps the exact OSS license from the pinned release archive', async () => {
  assert.equal(
    sha256(await readFile(join(root, 'docs/licenses', licenseName))),
    rtkRelease.licenseSha256,
  );
});

test('RTK plugin compiles to a standalone mods payload using the SDK file and permission APIs', async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['server/rtk-plugin/register.ts'],
    outfile: 'register.js',
    write: false,
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  assert.equal(result.outputFiles.length, 1);
  assert.doesNotMatch(result.outputFiles[0]?.text ?? '', /^import /m);
  assert.match(result.outputFiles[0]?.text ?? '', /\$\.fs\.read\(\$\.plugin\.root/);
  assert.match(result.outputFiles[0]?.text ?? '', /\$\.tool\.check\(/);
  assert.match(result.outputFiles[0]?.text ?? '', /export\s*\{\s*register\s*\}/);
});

test('inherited RTK resource and state overrides are cleared without changing application paths', () => {
  const environment = {
    PATH: '/ordinary/bin',
    XDG_CONFIG_HOME: '/ordinary/config',
    ATELIER_GATEWAY: 'http://127.0.0.1:8080',
    ATELIER_RTK_BINARY: '/untrusted/rtk',
    ATELIER_RTK_HOME: '/untrusted/state',
    ATELIER_BUILD_RTK_ARCHIVE: '/untrusted/asset',
    RTK_DB_PATH: '/untrusted/tracking.db',
    RTK_TELEMETRY_DISABLED: '0',
    RTK_FUTURE_OVERRIDE: 'untrusted',
  };
  clearRtkEnvironment(environment);
  assert.deepEqual(environment, {
    PATH: '/ordinary/bin',
    XDG_CONFIG_HOME: '/ordinary/config',
    ATELIER_GATEWAY: 'http://127.0.0.1:8080',
  });
});

test('RTK launcher uses only its sibling executable and scopes state variables to that process', async () => {
  await temporary(async (directory) => {
    const launcher = join(directory, 'resources/rtk/bin/rtk');
    const binary = join(directory, 'resources/rtk/rtk');
    const home = join(directory, 'private application state');
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(launcher, rtkLauncher, { mode: 0o755 });
    // Local Node is a stand-in, never the downloaded RTK executable.
    await symlink(process.execPath, binary);
    const probe = `console.log(JSON.stringify({
      args: process.argv.slice(1),
      environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(RTK_|XDG_)/.test(key)))
    }))`;
    const result = spawnSync(
      '/bin/sh',
      [launcher, '--input-type=module', '-e', probe, 'argument with spaces', 'literal;argument'],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: '/no-system-rtk-or-tools',
          NODE_OPTIONS: '',
          ATELIER_RTK_HOME: home,
          XDG_CONFIG_HOME: '/external/config',
          XDG_DATA_HOME: '/external/data',
          XDG_CACHE_HOME: '/external/cache',
          RTK_DB_PATH: '/external/tracking.sqlite',
          RTK_NO_TOML: '0',
          RTK_TELEMETRY_DISABLED: '0',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = z
      .object({ args: z.array(z.string()), environment: z.record(z.string(), z.string()) })
      .parse(JSON.parse(result.stdout));
    assert.deepEqual(output.args, ['argument with spaces', 'literal;argument']);
    for (const [key, value] of Object.entries({
      XDG_CONFIG_HOME: home + '/config',
      XDG_DATA_HOME: home + '/data',
      XDG_CACHE_HOME: home + '/cache',
      RTK_DB_PATH: `${home}/tracking.sqlite`,
      RTK_NO_TOML: '1',
      RTK_TELEMETRY_DISABLED: '1',
      RTK_TEE: '0',
      RTK_RECALL: '0',
      RTK_SUPPRESS_HOOK_WARNING: '1',
    }))
      assert.equal(output.environment[key], value, key);
    for (const value of ['', 'relative/state']) {
      const refused = spawnSync('/bin/sh', [launcher, '--version'], {
        cwd: root,
        env: { ...process.env, ATELIER_RTK_HOME: value },
        encoding: 'utf8',
      });
      assert.equal(refused.status, 64);
      assert.match(refused.stderr, /absolute application data path/);
    }
  });
});

test('launcher preserves caller XDG paths for wrapped tools and isolates RTK meta commands', async () => {
  await temporary(async (directory) => {
    const launcher = join(directory, 'resources/rtk/bin/rtk');
    const binary = join(directory, 'resources/rtk/rtk');
    const probe = join(directory, 'probe.cjs');
    const home = join(directory, 'application state');
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(launcher, rtkLauncher, { mode: 0o755 });
    await writeFile(
      probe,
      'console.log(JSON.stringify({args:process.argv.slice(2),config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,cache:process.env.XDG_CACHE_HOME,db:process.env.RTK_DB_PATH}));',
    );
    await writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(probe)} "$@"\n`, {
      mode: 0o755,
    });
    const commands = [
      [['git'], true],
      [['bypass'], true],
      [['--atelier-exec', 'rg'], true],
      [['--atelier-exec', 'npm'], true],
      [['--atelier-exec', 'docker'], true],
      [['gain'], false],
      [['config'], false],
      [['-v', 'config'], false],
      [['telemetry'], false],
    ] as const;
    for (const [args, preserve] of commands) {
      const result = spawnSync('/bin/sh', [launcher, ...args, 'literal argument'], {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          ATELIER_RTK_HOME: home,
          XDG_CONFIG_HOME: '/ordinary/config',
          XDG_DATA_HOME: '/ordinary/data',
          XDG_CACHE_HOME: '/ordinary/cache',
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      const output = z
        .object({
          args: z.array(z.string()),
          config: z.string(),
          data: z.string(),
          cache: z.string(),
          db: z.string(),
        })
        .parse(JSON.parse(result.stdout));
      const forwarded = args[0] === '--atelier-exec' ? args.slice(1) : args;
      assert.deepEqual(output.args, [...forwarded, 'literal argument']);
      assert.equal(output.config, preserve ? '/ordinary/config' : `${home}/config`);
      assert.equal(output.data, preserve ? '/ordinary/data' : `${home}/data`);
      assert.equal(output.cache, preserve ? '/ordinary/cache' : `${home}/cache`);
      assert.equal(output.db, `${home}/tracking.sqlite`);
    }
  });
});

test(
  'real pinned RTK preserves XDG Git ignore and config, bypass environment, and private tracking',
  {
    skip: process.env.ATELIER_TEST_REAL_RTK !== '1',
  },
  async () => {
    const supplied = process.env.ATELIER_TEST_RTK_ARCHIVE ?? rtkArchiveCachePath(root);
    await temporary(async (directory) => {
      const stage = join(directory, 'atelier');
      await mkdir(join(directory, 'docs/licenses'), { recursive: true });
      await copyFile(
        join(root, 'docs/licenses', licenseName),
        join(directory, 'docs/licenses', licenseName),
      );
      const staged = await stageRtkRelease(directory, directory, stage, supplied);
      const launcher = join(stage, staged.release.launcher.path);
      const home = join(directory, 'ordinary home');
      const config = join(directory, 'ordinary config');
      const data = join(directory, 'ordinary data');
      const cache = join(directory, 'ordinary cache');
      const project = join(directory, 'fixture project');
      const rtkHome = join(directory, 'app-private rtk');
      const claude = join(directory, 'isolated runtime claude');
      for (const path of [
        home,
        config,
        data,
        cache,
        claude,
        join(config, 'git'),
        join(config, 'rtk'),
        join(project, '.git/objects'),
        join(project, '.git/refs/heads'),
        join(project, '.rtk'),
        join(project, 'nested'),
      ])
        await mkdir(path, { recursive: true });
      // Construct an empty repository without invoking init, add or commit.
      await writeFile(join(project, '.git/HEAD'), 'ref: refs/heads/main\n');
      await writeFile(
        join(project, '.git/config'),
        '[core]\nrepositoryformatversion = 0\nbare = false\n',
      );
      await writeFile(
        join(config, 'git/config'),
        '[user]\nname = XDG-config-fixture\n[status]\nshowUntrackedFiles = all\n[core]\nquotePath = false\n',
      );
      await writeFile(join(config, 'git/ignore'), 'xdg-hidden.txt\n.rtk/\n');
      await writeFile(join(project, 'xdg-hidden.txt'), 'must stay ignored\n');
      await writeFile(join(project, 'nested/visible.txt'), 'must stay individually visible\n');
      const filter =
        'schema_version = 1\n[filters.fixture]\nmatch_command = ".*"\nmatch_output = [{ pattern = "(?s).*", message = "FORBIDDEN_CUSTOM_FILTER" }]\n';
      await writeFile(join(config, 'rtk/filters.toml'), filter);
      await writeFile(join(project, '.rtk/filters.toml'), filter);
      await writeFile(
        join(config, 'rtk/config.toml'),
        '[telemetry]\nenabled = true\nconsent_given = true\n',
      );
      const env: NodeJS.ProcessEnv = {
        PATH: '/usr/bin:/bin',
        HOME: home,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: cache,
        CLAUDE_CONFIG_DIR: claude,
        ATELIER_RTK_HOME: rtkHome,
        GIT_CONFIG_NOSYSTEM: '1',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
      };
      const fingerprint = async (path: string) => {
        const entries = await readdir(path, { recursive: true, withFileTypes: true });
        const values = await Promise.all(
          entries.map(async (entry) => {
            const full = join(entry.parentPath, entry.name);
            return [
              relative(path, full),
              entry.isDirectory() ? 'directory' : sha256(await readFile(full)),
            ];
          }),
        );
        return values.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      };
      const before = await Promise.all(
        [home, config, data, cache, join(project, '.rtk')].map(fingerprint),
      );
      const execute = (binary: string, args: string[]) => {
        const result = spawnSync(binary, args, {
          cwd: project,
          env,
          encoding: 'utf8',
          timeout: 15_000,
        });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, `${binary} ${args.join(' ')}\n${result.stderr}`);
        assert.doesNotMatch(result.stdout, /FORBIDDEN_CUSTOM_FILTER/);
        return result.stdout;
      };
      const native = execute('/usr/bin/git', ['status']);
      assert.doesNotMatch(native, /xdg-hidden/);
      assert.match(native, /nested\/visible\.txt/);
      const wrapped = execute(launcher, ['git', 'status']);
      assert.doesNotMatch(wrapped, /xdg-hidden/);
      assert.match(wrapped, /nested\/visible\.txt/);
      assert.equal(execute(launcher, ['bypass', 'git', 'status']), native);
      const configValue = execute('/usr/bin/git', ['config', '--get', 'user.name']);
      assert.equal(configValue, 'XDG-config-fixture\n');
      assert.equal(
        execute(launcher, ['bypass', 'git', 'config', '--get', 'user.name']),
        configValue,
      );
      const environmentProbe =
        'console.log(JSON.stringify({home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,cache:process.env.XDG_CACHE_HOME}))';
      const ordinary = execute(process.execPath, ['-e', environmentProbe]);
      assert.equal(
        execute(launcher, ['bypass', process.execPath, '-e', environmentProbe]),
        ordinary,
      );
      assert.equal(execute(launcher, ['/usr/bin/printf', 'fallback-stat\\n']), 'fallback-stat\n');
      execute(launcher, ['-v', 'config', 'recall', 'disabled']);
      execute(launcher, ['telemetry', 'disable']);
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(join(rtkHome, 'tracking.sqlite'), { readOnly: true });
      try {
        const rows = database.prepare('SELECT rtk_cmd FROM commands').all();
        assert.ok(rows.some((row) => String(row.rtk_cmd).startsWith('rtk fallback:')));
        assert.ok(rows.some((row) => String(row.rtk_cmd).startsWith('rtk bypass')));
      } finally {
        database.close();
      }
      assert.deepEqual(
        await Promise.all([home, config, data, cache, join(project, '.rtk')].map(fingerprint)),
        before,
        'normal Git/bypass/fallback must not write RTK state into ordinary HOME/XDG or project filters',
      );
    });
  },
);

test('runtime supervisor passes the absolute RTK resource via argv and removes inherited overrides', async () => {
  await temporary(async (directory) => {
    await mkdir(join(directory, 'bin'), { recursive: true });
    await mkdir(join(directory, 'server'), { recursive: true });
    await symlink(process.execPath, join(directory, 'bin/node'));
    await writeFile(
      join(directory, 'server/main.js'),
      `process.once('message', hello => {
        process.send({type:'atelier-host:ready',protocolVersion:hello.protocolVersion,generation:hello.generation,port:4318});
        process.send({argv:process.argv.slice(2),environment:Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:RTK_|ATELIER_RTK_|ATELIER_BUILD_RTK)/.test(key)))});
      });
      process.once('disconnect', () => process.exit(0));`,
    );
    const inherited = {
      ATELIER_RTK_BINARY: '/inherited/rtk',
      ATELIER_RTK_HOME: '/inherited/state',
      ATELIER_BUILD_RTK_ARCHIVE: '/inherited/archive',
      RTK_DB_PATH: '/inherited/tracking.db',
      RTK_TELEMETRY_DISABLED: '0',
    };
    const previous = Object.fromEntries(
      Object.keys(inherited).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, inherited);
    try {
      for (const binary of [join(directory, 'resources/rtk/rtk'), undefined]) {
        let receive: (value: unknown) => void = () => {};
        const captured = new Promise<unknown>((resolve) => {
          receive = resolve;
        });
        const supervisor = new RuntimeSupervisor(
          { packaged: true, root: directory, dataDir: join(directory, 'data'), rtkBinary: binary },
          (_child, value) => receive(value),
          () => {},
        );
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          assert.equal((await supervisor.start()).origin, 'http://127.0.0.1:4318');
          const probe = await Promise.race([
            captured,
            new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(
                () => reject(new Error('Runtime environment probe timed out.')),
                5_000,
              );
            }),
          ]);
          const output = z
            .object({ argv: z.array(z.string()), environment: z.record(z.string(), z.string()) })
            .parse(probe);
          assert.deepEqual(output.argv, binary ? ['--rtk-binary', binary] : []);
          assert.deepEqual(output.environment, {});
        } finally {
          clearTimeout(deadline);
          await supervisor.stop();
        }
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test('runtime supervisor refuses a relative RTK path before spawning', async () => {
  const supervisor = new RuntimeSupervisor(
    { packaged: true, root, dataDir: join(root, '.local/unused'), rtkBinary: 'rtk/from/PATH' },
    () => {},
    () => {},
  );
  await assert.rejects(supervisor.start(), /host.failure.startupFailed/);
  assert.equal(supervisor.connected, false);
});

test('RTK provisioning downloads only the fixed asset and rejects invalid network bytes', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    assert.equal(url, rtkRelease.source.archive);
    return new Response('invalid release bytes', { status: 200 });
  });
  await temporary(async (directory) => {
    await assert.rejects(prepareRtkRelease(directory, directory), /SHA-256 mismatch/);
    await assert.rejects(lstat(rtkArchiveCachePath(directory)), { code: 'ENOENT' });
  });
});

test('RTK provisioning rejects corrupt or symlinked supplied archives before extraction', async () => {
  await temporary(async (directory) => {
    const bad = join(directory, 'invalid.tar.gz');
    const link = join(directory, 'linked.tar.gz');
    await writeFile(bad, 'untrusted archive');
    await symlink(bad, link);
    await assert.rejects(prepareRtkRelease(root, directory, bad), /SHA-256 mismatch/);
    await assert.rejects(prepareRtkRelease(root, directory, link), /regular file/);
  });
});

test('pinned RTK cache stages verified resources and validates portable and Arch archive bytes', async (context) => {
  const supplied = process.env.ATELIER_TEST_RTK_ARCHIVE ?? rtkArchiveCachePath(root);
  try {
    await lstat(supplied);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      context.skip(
        'Pinned RTK archive unavailable; provide ATELIER_TEST_RTK_ARCHIVE or populate the digest-addressed cache.',
      );
      return;
    }
    throw error;
  }
  await temporary(async (directory) => {
    const stage = join(directory, 'atelier');
    await mkdir(join(directory, 'docs/licenses'), { recursive: true });
    await copyFile(
      join(root, 'docs/licenses', licenseName),
      join(directory, 'docs/licenses', licenseName),
    );
    const prepared = await stageRtkRelease(directory, directory, stage, supplied);
    assert.equal(prepared.inputs.archive, rtkArchiveCachePath(directory));
    assert.equal(prepared.release.sha256, rtkRelease.binarySha256);
    const binary = join(stage, prepared.release.path);
    const launcher = join(stage, prepared.release.launcher.path);
    assert.equal(sha256(await readFile(binary)), rtkRelease.binarySha256);
    assert.equal(await readFile(launcher, 'utf8'), rtkLauncher);
    assert.equal((await lstat(binary)).mode & 0o777, 0o755);
    assert.equal((await lstat(launcher)).mode & 0o777, 0o755);
    assert.equal((await lstat(join(stage, 'resources/licenses/rtk/LICENSE'))).mode & 0o777, 0o644);
    const portable = join(directory, 'portable.tar');
    const arch = join(directory, 'arch.tar');
    archive(['-cf', portable, '-C', directory, 'atelier']);
    archive(['-cf', arch, '-C', directory, '--transform=s,^atelier,opt/atelier,', 'atelier']);
    verifyRtkArchive(root, portable, 'atelier');
    verifyRtkArchive(root, arch, 'opt/atelier', 'bsdtar');
    // A verified cache suffices on the next build; no original /tmp path is needed.
    const cached = await prepareRtkRelease(directory, directory);
    assert.equal(sha256(await readFile(cached.binary)), rtkRelease.binarySha256);
    const releaseBytes = await readFile(supplied);
    let requests = 0;
    context.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      assert.equal(url, rtkRelease.source.archive);
      requests++;
      // Exercise the clean-checkout download path using the already pinned bytes.
      return new Response(releaseBytes, { status: 200 });
    });
    const cleanRoot = join(directory, 'clean checkout');
    const downloaded = await prepareRtkRelease(cleanRoot, directory);
    assert.equal(sha256(await readFile(downloaded.binary)), rtkRelease.binarySha256);
    await prepareRtkRelease(cleanRoot, directory);
    assert.equal(requests, 1);
    await chmod(launcher, 0o644);
    archive(['-cf', portable, '-C', directory, 'atelier']);
    assert.throws(() => verifyRtkArchive(root, portable, 'atelier'), /mode mismatch/);
    await chmod(launcher, 0o755);
    await writeFile(launcher, '#!/bin/sh\nexit 0\n');
    archive(['-cf', portable, '-C', directory, 'atelier']);
    assert.throws(() => verifyRtkArchive(root, portable, 'atelier'), /SHA-256 mismatch/);
    await writeFile(rtkArchiveCachePath(directory), 'corrupt cache');
    await assert.rejects(prepareRtkRelease(directory, directory), /SHA-256 mismatch/);
  });
});
