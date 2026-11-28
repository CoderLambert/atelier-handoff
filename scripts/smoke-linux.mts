#!/usr/bin/env -S tsx
/**
 * @file 组织已安装 Linux 应用的冒烟验收。
 * @implementation 在隔离环境运行验收驱动，核对 SQLite、PTY 和 RTK 资源清单及完整性。
 * @updated 2026-11-26T04:17:21+08:00
 */
// Controller only. esbuild emits the driver into a private test-resource directory;
// neither the driver nor its dependencies are copied into the distributed app.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, existsSync } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, cpus, release, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { rtkLauncher, rtkRelease } from '../shared/builtin-rtk.js';
import {
  assertPtyNativeFiles,
  ptyPackagePath,
  terminalReleaseSchema,
  terminalRuntimeVersions,
} from './linux/terminal-resources.mjs';
import {
  array,
  errorText,
  positive,
  record,
  redact,
  string,
  type DriverConfig,
} from './p1-smoke/contracts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const help = `Usage: tsx scripts/smoke-linux.mts --app /installed/atelier [options]
A positional installed executable is also accepted. Installs/extracts nothing.
  --playwright PATH  Existing playwright-core module directory (controller only)
  --xvfb PATH        Existing Xvfb executable (default: /usr/bin/Xvfb)
  --artifact PATH    Also record archive/package SHA-256 and bytes
  --startup-ms N     Usable UI budget per launch (default: 30000)
  --shutdown-ms N    Graceful process-tree shutdown budget (default: 10000)
  --rss-mib N        Optional sampled process-tree RSS budget
Ten fresh profile/data starts plus an offline persistence reopen. Dedicated Xvfb,
private PID/mount/network namespaces, separate HOME/XDG/profile/data/project,
installed artifact read-only, no source or development Node/npm/tsx in target.
Requires Linux, working bubblewrap, Xvfb and existing playwright-core. No paid call.
JSON, redacted logs and fixture screenshots remain in a fresh private temp directory.
Exit 0: passed; 1: acceptance failure; 2: prerequisites unavailable.
Fresh means empty profile/data, not flushed kernel disk caches.
`;

interface Options {
  app: string;
  playwright?: string;
  xvfb: string;
  artifact?: string;
  startupMs: number;
  shutdownMs: number;
  rssMiB: number | null;
}

export function options(args: string[]): Options | null {
  let app: string | undefined, playwright: string | undefined, artifact: string | undefined;
  let xvfb = '/usr/bin/Xvfb',
    startupMs = 30_000,
    shutdownMs = 10_000,
    rssMiB: number | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    assert.ok(arg);
    if (arg === '--help' || arg === '-h') return null;
    if (
      [
        '--app',
        '--playwright',
        '--xvfb',
        '--artifact',
        '--startup-ms',
        '--shutdown-ms',
        '--rss-mib',
      ].includes(arg)
    ) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      switch (arg) {
        case '--app':
          app = value;
          break;
        case '--playwright':
          playwright = value;
          break;
        case '--xvfb':
          xvfb = value;
          break;
        case '--artifact':
          artifact = value;
          break;
        case '--startup-ms':
          startupMs = positive(Number(value), arg);
          break;
        case '--shutdown-ms':
          shutdownMs = positive(Number(value), arg);
          break;
        case '--rss-mib':
          rssMiB = positive(Number(value), arg);
          break;
      }
    } else if (!arg.startsWith('-') && !app) app = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!app) throw new Error('--app or a positional installed executable is required');
  return { app, playwright, artifact, xvfb, startupMs, shutdownMs, rssMiB };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function inventory(
  root: string,
): Promise<{ sha256: string; bytes: number; files: number; algorithm: string }> {
  const hash = createHash('sha256');
  let bytes = 0,
    files = 0;
  async function walk(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const item = join(path, name),
        stat = await lstat(item),
        rel = relative(root, item);
      if (stat.isDirectory()) await walk(item);
      else if (stat.isSymbolicLink()) {
        const target = await realpath(item);
        assert.ok(
          target === root || target.startsWith(root + sep),
          `Artifact symlink escapes install directory: ${rel}`,
        );
        hash.update(JSON.stringify([rel, 'link', await readlink(item)]) + '\n');
      } else if (stat.isFile()) {
        hash.update(JSON.stringify([rel, stat.mode & 0o777, await hashFile(item)]) + '\n');
        bytes += stat.size;
        files++;
      } else throw new Error(`Unsupported installed artifact entry: ${rel}`);
    }
  }
  await walk(root);
  return {
    sha256: hash.digest('hex'),
    bytes,
    files,
    algorithm:
      'sorted newline JSON [relative path, mode, SHA-256] or [relative path, link, target]; empty directories excluded',
  };
}

async function verifyResources(
  install: string,
  installed: { files: number; bytes: number },
): Promise<Record<string, unknown>> {
  const path = join(install, 'resources/resource-inventory.json');
  const manifest = record(
    JSON.parse(await readFile(path, 'utf8')) as unknown,
    'resource inventory',
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.selfExcluded, 'resources/resource-inventory.json');
  const entries = array(manifest.files).map((value) => record(value, 'resource entry'));
  const seen = new Set<string>();
  let bytes = 0;
  for (const item of entries) {
    const name = string(item.path),
      target = resolve(install, name);
    assert.ok(
      target.startsWith(install + sep) && relative(install, target) === name && !seen.has(name),
      'Resource path must be unique and contained',
    );
    seen.add(name);
    const stat = await lstat(target);
    assert.ok(stat.isFile(), `Resource must be a regular file: ${name}`);
    assert.equal(stat.size, item.bytes, `Resource byte size: ${name}`);
    assert.equal((stat.mode & 0o777).toString(8), item.mode, `Resource mode: ${name}`);
    assert.equal(await hashFile(target), string(item.sha256), `Resource SHA-256: ${name}`);
    bytes += stat.size;
  }
  assert.equal(bytes, manifest.totalBytes, 'Resource total bytes');
  assert.equal(
    entries.length + 1,
    installed.files,
    'Inventory must cover every installed file except itself',
  );
  assert.equal(
    bytes + (await lstat(path)).size,
    installed.bytes,
    'Inventory must account for every installed byte',
  );
  assert.ok(
    ![...seen].some(
      (name) => /(?:^|\/)scripts\/p1-smoke\//.test(name) || /smoke-linux\.(?:mts|mjs)$/.test(name),
    ),
    'Acceptance driver must not be distributed',
  );
  const nativeBinding = 'resources/runtime/node_modules/better-sqlite3/prebuilds/linux-x64.node';
  const migrations = [
    'resources/runtime/server/db/migrations/0006-session-snapshot-indexes.sql',
    'resources/runtime/server/db/migrations/0007-subagents.sql',
    'resources/runtime/server/db/migrations/0008-git-worktrees.sql',
    'resources/runtime/server/db/migrations/0009-git-commit-operations.sql',
    'resources/runtime/server/db/migrations/0010-git-commit-operation-lifecycle.sql',
    'resources/runtime/server/db/migrations/0011-runtime-hotpath-indexes.sql',
    'resources/runtime/server/db/migrations/0012-scheduled-tasks.sql',
    'resources/runtime/server/db/migrations/0013-schedule-triggers.sql',
    'resources/runtime/server/db/migrations/0014-schedule-execution-preference.sql',
    'resources/runtime/server/db/migrations/0015-schedule-model-effort.sql',
  ];
  assert.deepEqual(
    [...seen].filter(
      (name) =>
        name.startsWith('resources/runtime/node_modules/better-sqlite3/') && name.endsWith('.node'),
    ),
    [nativeBinding],
    'SQLite must ship exactly the Linux x64 native prebuild',
  );
  for (const migration of migrations)
    assert.ok(seen.has(migration), `${migration} must be distributed`);
  const release = record(
    JSON.parse(await readFile(join(install, 'resources/release.json'), 'utf8')) as unknown,
  );
  const rtk = record(release.rtk);
  const rtkBinary = `resources/${rtkRelease.resourcePath}`;
  const rtkLauncherPath = `resources/${rtkRelease.launcherPath}`;
  const rtkLicense = 'resources/licenses/rtk/LICENSE';
  const rtkPlugin = 'resources/runtime/server/rtk-plugin/register.js';
  assert.equal(rtk.version, rtkRelease.version);
  assert.equal(rtk.license, rtkRelease.license);
  assert.equal(rtk.archiveSha256, rtkRelease.archiveSha256);
  assert.equal(rtk.path, rtkBinary);
  assert.equal(rtk.sha256, rtkRelease.binarySha256);
  for (const [name, digest, mode] of [
    [rtkBinary, rtkRelease.binarySha256, '755'],
    [rtkLauncherPath, createHash('sha256').update(rtkLauncher).digest('hex'), '755'],
    [rtkLicense, rtkRelease.licenseSha256, '644'],
  ]) {
    assert.ok(name && digest && mode);
    const resource = entries.find((item) => item.path === name);
    assert.ok(resource, `RTK resource must be distributed: ${name}`);
    assert.equal(resource.sha256, digest, `Pinned RTK resource: ${name}`);
    assert.equal(resource.mode, mode, `RTK resource mode: ${name}`);
  }
  assert.ok(seen.has(rtkPlugin), 'Static RTK plugin payload must be distributed');
  assert.deepEqual(record(rtk.launcher), {
    path: rtkLauncherPath,
    sha256: createHash('sha256').update(rtkLauncher).digest('hex'),
    mode: '755',
  });
  assert.deepEqual(array(rtk.texts), [
    { path: rtkLicense, sha256: rtkRelease.licenseSha256, source: rtkRelease.source.archive },
  ]);
  const licenses = record(
    JSON.parse(
      await readFile(join(install, 'resources/licenses/inventory.json'), 'utf8'),
    ) as unknown,
  );
  assert.deepEqual(licenses.rtk, rtk, 'RTK license and release inventories must agree');
  const sqlite = record(release.sqlite);
  const binding = record(sqlite.nativeBinding);
  assert.equal(binding.path, nativeBinding);
  assert.equal(binding.sha256, await hashFile(join(install, nativeBinding)));
  assert.deepEqual(
    array(sqlite.migrations),
    await Promise.all(
      migrations.map(async (path) => ({ path, sha256: await hashFile(join(install, path)) })),
    ),
  );
  const runtimePackage = record(
    JSON.parse(await readFile(join(install, 'resources/runtime/package.json'), 'utf8')) as unknown,
  );
  const runtimeDependencies = record(runtimePackage.dependencies);
  const terminal = terminalReleaseSchema.parse(release.terminal);
  const ptyPrefix = `resources/runtime/${ptyPackagePath}/`;
  assertPtyNativeFiles(
    [...seen]
      .filter((name) => name.startsWith(ptyPrefix))
      .map((name) => name.slice(ptyPrefix.length)),
  );
  assert.equal(
    terminal.nativeBinding.sha256,
    await hashFile(join(install, terminal.nativeBinding.path)),
    'Terminal native binding SHA-256',
  );
  for (const [name, version] of Object.entries(terminalRuntimeVersions)) {
    assert.equal(runtimeDependencies[name], version, `Terminal runtime manifest: ${name}`);
    const installedPackage = record(
      JSON.parse(
        await readFile(
          join(install, 'resources/runtime/node_modules', name, 'package.json'),
          'utf8',
        ),
      ) as unknown,
    );
    assert.equal(installedPackage.version, version, `Terminal installed dependency: ${name}`);
  }
  for (const [key, name, version] of [
    ['driver', 'better-sqlite3', '13.2.0'],
    ['orm', 'drizzle-orm', '0.45.4'],
  ]) {
    assert.ok(key && name && version);
    assert.deepEqual(record(sqlite[key]), { name, version });
    assert.equal(runtimeDependencies[name], version);
    const installedPackage = record(
      JSON.parse(
        await readFile(
          join(install, 'resources/runtime/node_modules', name, 'package.json'),
          'utf8',
        ),
      ) as unknown,
    );
    assert.equal(installedPackage.version, version);
  }
  return {
    verified: true,
    files: entries.length,
    bytes,
    manifestSha256: await hashFile(path),
    modesVerified: true,
    complete: true,
    testDriverDistributed: false,
    sqlite: { ...sqlite, manifestsVerified: true, exclusiveNativePrebuild: true },
    terminal: { ...terminal, manifestsVerified: true, exclusiveNativeBinding: true },
    rtk: { ...rtk, manifestsVerified: true, pinnedResourcesVerified: true, plugin: rtkPlugin },
  };
}

interface PackageEntry {
  launcher: string;
  evidence: Record<string, unknown>;
}

async function packageEntry(install: string): Promise<PackageEntry | null> {
  if (basename(dirname(install)) !== 'opt') return null;
  const prefix = dirname(dirname(install));
  const launcher = join(prefix, 'usr/bin/atelier');
  const desktop = join(prefix, 'usr/share/applications/atelier.desktop');
  const icon = join(prefix, 'usr/share/icons/hicolor/scalable/apps/atelier.svg');
  for (const path of [launcher, desktop, icon])
    assert.ok((await lstat(path)).isFile(), 'Packaged menu assets must be regular files');
  await access(launcher, constants.X_OK);
  assert.equal(
    (await readFile(launcher, 'utf8')).trim(),
    '#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nexec /opt/atelier/atelier "$@"',
  );
  const text = await readFile(desktop, 'utf8');
  assert.ok(text.startsWith('[Desktop Entry]\n'));
  for (const [key, expected] of Object.entries({
    Type: 'Application',
    Name: 'atelier',
    Exec: 'atelier',
    TryExec: 'atelier',
    Icon: 'atelier',
    Terminal: 'false',
    StartupWMClass: 'atelier',
  })) {
    const values = text
      .split('\n')
      .filter((line) => line.startsWith(key + '='))
      .map((line) => line.slice(key.length + 1));
    assert.deepEqual(values, [expected], `Desktop entry ${key}`);
  }
  assert.equal(await hashFile(icon), await hashFile(join(install, 'atelier.svg')));
  assert.equal(await hashFile(desktop), await hashFile(join(install, 'atelier.desktop')));
  let metadataPath = join(prefix, '.PKGINFO');
  if (existsSync(metadataPath)) {
    const metadata = await readFile(metadataPath, 'utf8');
    assert.match(metadata, /^pkgname = atelier$/m);
    assert.match(metadata, /^arch = x86_64$/m);
  } else {
    // pacman stores installed metadata in its local database, not at the system root.
    const db = join(prefix, 'var/lib/pacman/local');
    const candidates = (await readdir(db, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && entry.name.startsWith('atelier-'),
    );
    const matches: string[] = [];
    for (const entry of candidates) {
      const path = join(db, entry.name, 'desc');
      const metadata = await readFile(path, 'utf8');
      if (/^%NAME%\natelier$/m.test(metadata) && /^%ARCH%\nx86_64$/m.test(metadata))
        matches.push(path);
    }
    assert.equal(matches.length, 1, 'Installed atelier must have one x86_64 pacman record');
    metadataPath = string(matches[0]);
  }
  return {
    launcher,
    evidence: {
      desktopEntry: true,
      exec: 'atelier',
      tryExec: 'atelier',
      iconMatches: true,
      launcherForwardsArguments: true,
      launcherClearsElectronRunAsNode: true,
      launcherSha256: await hashFile(launcher),
      desktopSha256: await hashFile(desktop),
      iconSha256: await hashFile(icon),
      packageMetadataSha256: await hashFile(metadataPath),
    },
  };
}

async function playwrightRoot(
  value: string | undefined,
): Promise<{ root: string; version: string }> {
  const require = createRequire(import.meta.url);
  let path: string;
  if (value) {
    path = resolve(value);
    if ((await lstat(path)).isDirectory()) path = join(path, 'package.json');
  } else {
    try {
      path = require.resolve('playwright-core/package.json');
    } catch {
      throw new Error(
        'Existing playwright-core required: pass --playwright /path/to/playwright-core',
      );
    }
  }
  const root = dirname(await realpath(path));
  const pkg = record(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as unknown);
  assert.equal(pkg.name, 'playwright-core');
  const loaded = record((await import(pathToFileURL(join(root, 'index.mjs')).href)) as unknown);
  assert.equal(typeof record(loaded.chromium).connectOverCDP, 'function');
  return { root, version: string(pkg.version) };
}

async function main(): Promise<void> {
  let scratch: string | undefined;
  const report: Record<string, unknown> = {
    schema: 1,
    status: 'prerequisite-failed',
    validation: 'installed-linux-p1',
    paidModelCalls: 0,
  };
  try {
    const opts = options(process.argv.slice(2));
    if (!opts) {
      process.stdout.write(help);
      return;
    }
    assert.equal(process.platform, 'linux', 'Installed smoke requires Linux');
    scratch = await mkdtemp(join(tmpdir(), 'atelier-p1-smoke-'));
    await mkdir(join(scratch, 'empty-path'));
    const app = await realpath(resolve(opts.app)),
      install = dirname(app);
    assert.ok((await lstat(app)).isFile(), '--app must be an installed executable');
    await access(app, constants.X_OK);
    for (const item of [
      'resources/app/main.mjs',
      'resources/runtime/bin/node',
      'resources/runtime/server/main.js',
      'resources/runtime/dist/client/index.html',
    ])
      await access(join(install, item), constants.R_OK);
    await access(join(install, 'resources/runtime/bin/node'), constants.X_OK);
    const xvfb = await realpath(resolve(opts.xvfb));
    await access(xvfb, constants.X_OK);
    await access('/usr/bin/bwrap', constants.X_OK);
    const playwright = await playwrightRoot(opts.playwright ?? process.env.PLAYWRIGHT_MODULE);
    const installed = await inventory(install);
    report.resources = await verifyResources(install, installed);
    const entry = await packageEntry(install);
    if (entry) report.packageIntegration = entry.evidence;
    const artifact = opts.artifact ? await realpath(resolve(opts.artifact)) : undefined;
    report.system = {
      platform: process.platform,
      arch: arch(),
      kernel: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      osRelease: existsSync('/etc/os-release') ? await readFile('/etc/os-release', 'utf8') : null,
    };
    const artifactEvidence = {
      executable: basename(app),
      executableSha256: await hashFile(app),
      installed,
      unchanged: false,
      distribution: artifact
        ? {
            name: basename(artifact),
            sha256: await hashFile(artifact),
            bytes: (await lstat(artifact)).size,
          }
        : null,
    };
    report.artifact = artifactEvidence;
    report.tooling = {
      controllerNode: process.version,
      playwright: playwright.version,
      xvfbSha256: await hashFile(xvfb),
    };
    report.isolation = {
      sourceMounted: false,
      privateNetwork: true,
      display: 'dedicated Xvfb inside private PID/mount/network namespaces',
      applicationPath: '/opt/atelier',
      targetPath: 'packaged runtime bin plus empty directory',
      directories:
        'separate HOME, XDG config/data/cache/runtime, Electron profile, application data, project; ten fresh datasets and first dataset reopened',
      missingBwrap: 'bwrap masked on disk and absent from target PATH',
      driver:
        'TypeScript compiled as external temporary test resource; installed executable launched normally with CDP flags; no main/preload injection',
    };
    const config: DriverConfig = {
      app: `/opt/atelier/${relative(install, app)}`,
      launcher: entry ? '/opt/smoke-launcher' : null,
      xvfb: '/opt/smoke-Xvfb',
      playwright: '/test-driver/index.mjs',
      sourceProbe: resolve(here, '..', 'server/main.ts'),
      startupMs: opts.startupMs,
      shutdownMs: opts.shutdownMs,
      rssMiB: opts.rssMiB,
    };
    await writeFile(join(scratch, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const resource = join(scratch, 'test-resource');
    await mkdir(resource);
    await build({
      entryPoints: [join(here, 'p1-smoke/driver.mts')],
      outfile: join(resource, 'driver.mjs'),
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      packages: 'bundle',
      logLevel: 'silent',
    });
    report.testResource = {
      sha256: await hashFile(join(resource, 'driver.mjs')),
      distributedWithProgram: false,
    };
    const args = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--clearenv',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib',
      '/lib64',
      '--ro-bind',
      '/etc',
      '/etc',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--dir',
      '/home',
      '--dir',
      '/opt',
      '--bind',
      scratch,
      '/smoke',
      '--ro-bind',
      install,
      '/opt/atelier',
      '--ro-bind',
      resource,
      '/acceptance',
      '--ro-bind',
      playwright.root,
      '/test-driver',
      '--ro-bind',
      xvfb,
      '/opt/smoke-Xvfb',
    ];
    if (entry) args.push('--ro-bind', entry.launcher, '/opt/smoke-launcher');
    const masked = new Set<string>();
    for (const path of [
      '/usr/bin/node',
      '/usr/bin/nodejs',
      '/usr/bin/npm',
      '/usr/bin/npx',
      '/usr/bin/tsx',
      '/usr/bin/corepack',
      '/usr/bin/bwrap',
    ]) {
      if (!existsSync(path)) continue;
      const target = await realpath(path);
      if (!masked.has(target)) {
        args.push('--ro-bind', '/dev/null', target);
        masked.add(target);
      }
    }
    for (const path of ['/usr/lib/node_modules', '/usr/share/nodejs'])
      if (existsSync(path)) args.push('--tmpfs', path);
    args.push(
      '--setenv',
      'PATH',
      '/smoke/empty-path',
      '--setenv',
      'HOME',
      '/smoke/controller-home',
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--setenv',
      'LANG',
      'C.UTF-8',
      '--chdir',
      '/smoke',
      '/opt/atelier/resources/runtime/bin/node',
      '/acceptance/driver.mjs',
      '/smoke/config.json',
    );
    let output = '';
    const started = performance.now();
    const sandbox = spawn('/usr/bin/bwrap', args, {
      cwd: scratch,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-128 * 1024);
    };
    sandbox.stdout.on('data', append);
    sandbox.stderr.on('data', append);
    const killOwnedNamespace = (): void => {
      sandbox.kill('SIGKILL');
    };
    process.once('SIGINT', killOwnedNamespace);
    process.once('SIGTERM', killOwnedNamespace);
    const watchdog = setTimeout(
      killOwnedNamespace,
      6 * (opts.startupMs + opts.shutdownMs) + 150_000,
    );
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await new Promise((resolve, reject) => {
        sandbox.once('error', reject);
        sandbox.once('exit', (code, signal) => resolve({ code, signal }));
      });
    } finally {
      clearTimeout(watchdog);
      process.removeListener('SIGINT', killOwnedNamespace);
      process.removeListener('SIGTERM', killOwnedNamespace);
    }
    report.durationMs = Math.round(performance.now() - started);
    report.sandboxExit = exit;
    const substitutions = [
      [scratch, '<scratch>'],
      [install, '<installed>'],
      [process.env.HOME, '<home>'],
      [resolve(here, '..'), '<source>'],
    ] as const;
    await writeFile(join(scratch, 'controller.log'), redact(output, substitutions), {
      mode: 0o600,
    });
    let inner: Record<string, unknown>;
    try {
      inner = record(
        JSON.parse(await readFile(join(scratch, 'acceptance.json'), 'utf8')) as unknown,
      );
    } catch {
      throw new Error(
        `Acceptance driver did not produce JSON; sandbox exit ${JSON.stringify(exit)}; ${redact(output.slice(-4000), substitutions)}`,
      );
    }
    report.acceptance = inner;
    artifactEvidence.unchanged = (await inventory(install)).sha256 === installed.sha256;
    report.status =
      exit.code === 0 && inner.status === 'passed' && artifactEvidence.unchanged
        ? 'passed'
        : 'failed';
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch (error) {
    report.error = redact(errorText(error), [
      [process.env.HOME, '<home>'],
      [scratch, '<scratch>'],
    ]);
    process.exitCode = 2;
    if (!scratch) process.stderr.write(`${String(report.error)}\n`);
  } finally {
    if (scratch) {
      const json = JSON.stringify(report, null, 2) + '\n';
      await writeFile(join(scratch, 'report.json'), json, { mode: 0o600 });
      process.stderr.write(`Disposable evidence: ${scratch}/report.json\n`);
      process.stdout.write(json);
    }
  }
}

await main();
