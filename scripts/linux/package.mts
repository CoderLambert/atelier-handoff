#!/usr/bin/env node
/**
 * @file 构建 Linux x64 应用发布包。
 * @implementation 校验运行时、RTK、终端依赖和许可证，核对暂存与发行工件的资源、哈希和模式。
 * @updated 2026-11-26T04:17:21+08:00
 */
// Linux x64/glibc only: build the production frontend, then run with tsx.
// Uses installed runtimes and one pinned RTK archive/cache; no dependency installs, root, or git.
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { build, type BuildOptions, type Plugin } from 'esbuild';
import { z } from 'zod';
import {
  ptyPackagePath,
  selectPtyPackageFiles,
  terminalNativeResource,
  terminalProbeResultSchema,
  terminalReleaseSchema,
  terminalRuntimeVersions,
} from './terminal-resources.mjs';
import { rtkLauncher, rtkRelease } from '../../shared/builtin-rtk.js';
import { stageRtkRelease, verifyRtkArchive } from './rtk.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'dist/linux');
const ELECTRON_VERSION = '45.4.1';
const NODE_VERSION = '24.21.0';
const ORM_VERSION = '0.45.4';
// npm omits the Apache text; upstream tag 0.45.4 resolves to this commit.
const ORM_LICENSE = {
  sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
  source:
    'https://raw.githubusercontent.com/drizzle-team/drizzle-orm/eab8bedbb65d5429c54e612ddbd88aa23091d398/LICENSE',
};
const SQLITE_DRIVER_VERSION = '13.2.0';
const SQLITE_NATIVE_BINDING = 'prebuilds/linux-x64.node';
const RUNTIME_MIGRATIONS = [
  'server/db/migrations/0006-session-snapshot-indexes.sql',
  'server/db/migrations/0007-subagents.sql',
  'server/db/migrations/0008-git-worktrees.sql',
  'server/db/migrations/0009-git-commit-operations.sql',
  'server/db/migrations/0010-git-commit-operation-lifecycle.sql',
  'server/db/migrations/0011-runtime-hotpath-indexes.sql',
  'server/db/migrations/0012-scheduled-tasks.sql',
  'server/db/migrations/0013-schedule-triggers.sql',
  'server/db/migrations/0014-schedule-execution-preference.sql',
  'server/db/migrations/0015-schedule-model-effort.sql',
];
// LICENSE from the official Node 24.21.0 distribution, never host /usr/share.
const NODE_LICENSE_SHA256 = '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace';
// Audited Cargo install: shunt-gateway 0.64.0, x86_64-unknown-linux-gnu.
// This version has no --version flag; the binary hash pins its identity.
const SHUNT = {
  name: 'shunt-gateway',
  version: '0.64.0',
  path: 'resources/shunt/shunt',
  sha256: '4436580d9bdc93f14304ca794f20e52fd4fcdef03d017cfefec583c53bbe532b',
  platform: 'linux',
  arch: 'x64',
  license: 'MIT OR Apache-2.0',
  attribution: 'Copyright (c) 2026 Passion Factory',
  source: {
    repository: 'https://github.com/pleaseai/shunt',
    tag: 'v0.64.0',
    commit: 'ace707b1075ec6bc522f8a1c21904f227ae440c2',
  },
};
// Byte-for-byte copies from that pinned source, kept alongside npm supplements.
const SHUNT_LICENSES = [
  {
    name: 'LICENSE-MIT',
    sha256: '00911484ad05ce7ea922b07e44b44c4076a75f1a3832fa2f56628783ded56c9b',
  },
  {
    name: 'LICENSE-APACHE',
    sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  },
];
const DEFAULT_EPOCH = 1795132800; // 2026-11-20T00:00:00Z
const epochText = process.env.SOURCE_DATE_EPOCH ?? String(DEFAULT_EPOCH);
const epoch = Number(epochText);
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  SOURCE_DATE_EPOCH: String(epoch),
  TZ: 'UTC',
  LC_ALL: 'C',
  PACKAGER: 'atelier local release',
  NODE_PATH: '',
  NODE_OPTIONS: '',
  ELECTRON_RUN_AS_NODE: '',
};

const runtimeRoots = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/sdk',
  'better-sqlite3',
  'chokidar',
  'croner',
  'diff',
  'drizzle-orm',
  'mammoth',
  'pdfjs-dist',
  'playwright-core',
  'xlsx',
  'yaml',
  'yauzl',
  'zod',
  ...Object.keys(terminalRuntimeVersions),
];
const nativeCli = '@anthropic-ai/claude-agent-sdk-linux-x64';
const forbiddenDirectories = new Set([
  'node_modules',
  'test',
  'tests',
  '__tests__',
  'spec',
  'example',
  'examples',
  'benchmark',
  'benchmarks',
  'bench',
  'docs',
  'doc',
  'coverage',
  '.data',
]);
const licenseName = /^(?:licen[cs]e|copying|notice|copyright)(?:[.-].*)?$/i;
const playwrightNotice = /^(?:ThirdPartyNotices\.txt|lib\/[^/]+\.LICENSE)$/;
const configName =
  /^(?:tsconfig|eslint|prettier|rollup|webpack|vite|vitest|jest|gulp|grunt|babel)(?:[.-]|$)/i;
const releaseExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.node', '.wasm']);
const electronFiles = [
  'electron',
  'chrome-sandbox',
  'chrome_crashpad_handler',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'icudtl.dat',
  'libffmpeg.so',
  'libvk_swiftshader.so',
  'libvulkan.so.1',
  'resources.pak',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'vk_swiftshader_icd.json',
  'LICENSE',
  'LICENSES.chromium.html',
  'version',
];

// Validate every field used from npm metadata and subprocess JSON. Unknown fields
// stay unknown; they never stand in for validation of a release decision.
const packageName = z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
const dependencyMap = z.record(packageName, z.string().min(1));
const manifestSchema = z.looseObject({
  name: packageName,
  version: z.string().min(1),
  license: z
    .union([z.string(), z.object({ type: z.string(), url: z.string().optional() })])
    .optional(),
  dependencies: dependencyMap.optional(),
  devDependencies: dependencyMap.optional(),
  optionalDependencies: dependencyMap.optional(),
  peerDependencies: dependencyMap.optional(),
  peerDependenciesMeta: z
    .record(packageName, z.looseObject({ optional: z.boolean().optional() }))
    .optional(),
  os: z.array(z.string()).optional(),
  cpu: z.array(z.string()).optional(),
  libc: z.array(z.string()).optional(),
  claudeCodeVersion: z.string().optional(),
});
type Manifest = z.infer<typeof manifestSchema>;
const lockEntrySchema = z.looseObject({
  version: z.string().optional(),
  link: z.boolean().optional(),
  resolved: z.string().optional(),
  dev: z.boolean().optional(),
});
function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
const lockSchema = z.looseObject({
  lockfileVersion: z.literal(3),
  packages: z.record(
    z.string().refine((path) => path === '' || safeRelative(path)),
    lockEntrySchema,
  ),
});
type Lock = z.infer<typeof lockSchema>;
const electronIdentitySchema = z.object({
  version: z.literal(ELECTRON_VERSION),
  arch: z.literal('x64'),
  platform: z.literal('linux'),
});
const nodeIdentitySchema = z.object({
  version: z.literal(NODE_VERSION),
  arch: z.literal('x64'),
  platform: z.literal('linux'),
  glibc: z.string().min(1),
});
interface ReleasePackage {
  path: string;
  manifest: Manifest;
}
interface StagedDependency {
  path: string;
  name: string;
  version: string;
  files: string[];
}
interface LicenseText {
  path: string;
  sha256: string;
  source?: string;
}
interface LicenseEntry {
  name: string;
  version: string;
  dependencyPath: string;
  license: NonNullable<Manifest['license']>;
  shippedAsRuntimePackage: boolean;
  texts: LicenseText[];
  missingLicenseText: boolean;
}
interface InventoryEntry {
  path: string;
  bytes: number;
  mode: string;
  sha256: string;
}
interface InputEntry {
  path: string;
  bytes: number;
  sha256: string;
  uses: string[];
}
interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}
const inputs = new Map<string, InputEntry>();

function run(command: string, args: string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status} (signal ${result.signal}):\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout.trim();
}
function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}
function inputName(path: string): string {
  const name = relative(root, path);
  return name.startsWith(`..${sep}`) || isAbsolute(name) ? path : name;
}
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
async function hash(path: string): Promise<string> {
  const digest = createHash('sha256');
  await pipeline(createReadStream(path), digest);
  return digest.digest('hex');
}
async function rememberInput(path: string, use: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Release input must be a regular file: ${path}`);
  const sha256 = await hash(path);
  const previous = inputs.get(path);
  if (previous && previous.sha256 !== sha256)
    throw new Error(`Input changed during packaging: ${path}`);
  if (previous) {
    if (!previous.uses.includes(use)) previous.uses.push(use);
  } else inputs.set(path, { path: inputName(path), bytes: info.size, sha256, uses: [use] });
  return sha256;
}
async function inputText(path: string, use = 'metadata'): Promise<string> {
  const expected = await rememberInput(path, use);
  const text = await readFile(path, 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== expected)
    throw new Error(`Input changed while reading: ${path}`);
  return text;
}
async function manifest(path: string): Promise<Manifest> {
  return manifestSchema.parse(parseJson(await inputText(join(path, 'package.json'))));
}
async function shuntInput(): Promise<string> {
  const explicit = process.env.ATELIER_BUILD_SHUNT;
  const candidates = explicit
    ? [resolve(explicit)]
    : [
        ...(environment.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory, 'shunt')),
        join(homedir(), '.cargo/bin/shunt'),
      ];
  let binary: string | undefined;
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const path = await realpath(candidate);
    const info = await stat(path);
    if (!info.isFile() || !(info.mode & 0o111)) continue;
    binary = path;
    break;
  }
  if (!binary)
    throw new Error(
      `Missing Shunt ${SHUNT.version} Linux x64 executable; set ATELIER_BUILD_SHUNT to the pinned binary, or install it on PATH or in ~/.cargo/bin/shunt.`,
    );
  const sha256 = await rememberInput(binary, 'shunt-identity');
  if (sha256 !== SHUNT.sha256)
    throw new Error(
      `Shunt ${SHUNT.version} SHA-256 mismatch at ${binary}: expected ${SHUNT.sha256}, got ${sha256}. Set ATELIER_BUILD_SHUNT to the pinned Linux x64 binary.`,
    );
  const handle = await open(binary, 'r');
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 || // ELF64
      header[5] !== 1 || // Little endian
      ![0, 3].includes(header[7] ?? -1) || // System V or Linux ABI
      ![2, 3].includes(header.readUInt16LE(16)) || // Executable or PIE
      header.readUInt16LE(18) !== 62 // AMD x86-64
    )
      throw new Error(`Shunt must be a Linux x64 ELF executable: ${binary}`);
  } finally {
    await handle.close();
  }
  return binary;
}
async function put(path: string, data: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, { mode });
  await chmod(path, mode);
}
async function putJson(path: string, data: unknown): Promise<void> {
  await put(path, `${JSON.stringify(data, null, 2)}\n`);
}
async function copy(source: string, destination: string, mode?: number): Promise<void> {
  const expected = await rememberInput(source, `copied:${inputName(destination)}`);
  const info = await lstat(source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, mode ?? (info.mode & 0o111 ? 0o755 : 0o644));
  if ((await hash(destination)) !== expected)
    throw new Error(`Input changed while copying: ${source}`);
}
async function files(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const path = join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Symlinks are not allowed in release input: ${path}`);
    if (entry.isDirectory()) result.push(...(await files(path, name)));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unexpected release input type: ${path}`);
  }
  return result;
}
async function normalize(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await normalize(path);
    await utimes(path, epoch, epoch);
  }
  await chmod(directory, 0o755);
  await utimes(directory, epoch, epoch);
}
function platformAllowed(values: string[] | undefined, target: string): boolean {
  return (
    !values ||
    (!values.includes(`!${target}`) &&
      (!values.some((value) => !value.startsWith('!')) || values.includes(target)))
  );
}
function onPlatform(value: Manifest): boolean {
  return (
    platformAllowed(value.os, 'linux') &&
    platformAllowed(value.cpu, 'x64') &&
    platformAllowed(value.libc, 'glibc')
  );
}
async function dependency(name: string, from: string): Promise<string> {
  packageName.parse(name);
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name);
    if (await exists(join(candidate, 'package.json'))) return candidate;
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent !== root && !safeRelative(relative(root, parent))) break;
  }
  throw new Error(
    `Missing locked release dependency ${name}, requested from ${relative(root, from)}`,
  );
}
async function closure(seeds: string[], lock: Lock, strict = true): Promise<ReleasePackage[]> {
  const packages = new Map<string, ReleasePackage>();
  async function visit(path: string): Promise<void> {
    if (packages.has(path)) return;
    const value = await manifest(path);
    if (!onPlatform(value))
      throw new Error(`Required dependency does not support Linux x64/glibc: ${path}`);
    const lockPath = relative(root, path);
    const locked = lock.packages[lockPath];
    if (locked?.link && (!locked.resolved || !safeRelative(locked.resolved)))
      throw new Error(`Invalid workspace link in package-lock.json: ${lockPath}`);
    const resolvedLock = locked?.link && locked.resolved ? lock.packages[locked.resolved] : locked;
    if (!resolvedLock || resolvedLock.version !== value.version)
      throw new Error(`Installed package does not match package-lock.json: ${lockPath}`);
    if (resolvedLock.dev) {
      if (!strict) return;
      throw new Error(`Developer dependency would enter release: ${lockPath}`);
    }
    packages.set(path, { path: lockPath, manifest: value });
    const names = new Set([
      ...Object.keys(value.dependencies ?? {}),
      ...Object.keys(value.peerDependencies ?? {}).filter(
        (name) => !value.peerDependenciesMeta?.[name]?.optional,
      ),
    ]);
    if (value.name === '@anthropic-ai/claude-agent-sdk') names.add(nativeCli);
    for (const name of [...names].sort()) await visit(await dependency(name, path));
  }
  for (const name of seeds) await visit(await dependency(name, root));
  return [...packages.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
async function packageFiles(directory: string, value: Manifest, prefix = ''): Promise<string[]> {
  if (value.name === 'node-pty') return selectPtyPackageFiles(directory);
  const selected: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // Package roots may contain development trees; nested names such as
    // yaml/dist/doc are executable modules and must not be mistaken for docs.
    if (
      entry.name.startsWith('.') ||
      entry.name === 'node_modules' ||
      (prefix === '' && forbiddenDirectories.has(entry.name))
    )
      continue;
    const path = join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Dependency contains unexpected symlink: ${path}`);
    if (value.name === 'better-sqlite3') {
      // v13 loads an N-API prebuild directly. Exclude local node-gyp builds,
      // sources and other platforms so a host build cannot override this pin.
      if (prefix === '' && entry.isDirectory() && !['lib', 'prebuilds'].includes(entry.name))
        continue;
      if (extname(name) === '.node' && name !== SQLITE_NATIVE_BINDING) continue;
    }
    if (entry.isDirectory()) selected.push(...(await packageFiles(path, value, name)));
    else if (entry.isFile()) {
      const legal =
        licenseName.test(entry.name) ||
        (value.name === 'playwright-core' && playwrightNotice.test(name)) ||
        (value.name.startsWith('@anthropic-ai/claude-agent-sdk') && name === 'README.md');
      const code =
        releaseExtensions.has(extname(entry.name)) &&
        !configName.test(entry.name) &&
        !/(?:^|[.-])(?:test|spec|bench)(?:[.-]|$)/i.test(entry.name) &&
        !entry.name.endsWith('.map');
      const pdfTextAsset =
        value.name === 'pdfjs-dist' &&
        /^(?:cmaps\/[^/]+\.bcmap|standard_fonts\/[^/]+\.(?:pfb|ttf))$/.test(name);
      if (legal || code || pdfTextAsset || (value.name === nativeCli && name === 'claude'))
        selected.push(name);
    } else throw new Error(`Unexpected dependency input type: ${path}`);
  }
  return selected.sort();
}
function requirePackage(packages: ReleasePackage[], name: string): ReleasePackage {
  const result = packages.find(
    (item) => item.manifest.name === name && item.path === `node_modules/${name}`,
  );
  if (!result) throw new Error(`Missing release root package: ${name}`);
  return result;
}
const inputPlugin: Plugin = {
  name: 'record-release-inputs',
  setup(context) {
    context.onLoad({ filter: /\.(?:[cm]?[jt]s|json)$/ }, async ({ path }) => {
      await rememberInput(path, 'compiled');
      return undefined;
    });
  },
};
async function compileDesktop(entry: string, outfile: string, preload: boolean): Promise<string[]> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    packages: 'bundle',
    external: ['electron'],
    platform: 'node',
    format: preload ? 'cjs' : 'esm',
    target: 'node24',
    sourcemap: false,
    legalComments: 'eof',
    metafile: true,
    plugins: [inputPlugin],
  });
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  for (const value of Object.values(result.metafile.outputs)) {
    for (const imported of value.imports) {
      if (
        !imported.external ||
        (imported.path !== 'electron' && (preload || !builtins.has(imported.path)))
      )
        throw new Error(
          `Unexpected ${preload ? 'sandbox preload' : 'main'} import: ${imported.path}`,
        );
    }
  }
  // A sandboxed preload can require Electron only. Shared schema dependencies
  // must be bundled rather than left for its restricted require implementation.
  return Object.keys(result.metafile.inputs).sort();
}
async function safeOutputDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`Output must be a real directory: ${path}`);
}
async function verifyInputs(): Promise<void> {
  for (const [path, value] of inputs)
    if ((await hash(path)) !== value.sha256)
      throw new Error(`Input changed during packaging; rebuild from stable source: ${path}`);
}

async function packageRelease(work: string): Promise<string[]> {
  const stage = join(work, 'atelier');
  const runtime = join(stage, 'resources/runtime');
  const artifacts = join(work, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const project = await manifest(root);
  const lock = lockSchema.parse(parseJson(await inputText(join(root, 'package-lock.json'))));
  if (!/^\d+\.\d+\.\d+$/.test(project.version))
    throw new Error('Expected a numeric release version.');
  if (!project.dependencies) throw new Error('Application dependencies are missing.');
  if (
    project.devDependencies?.electron !== ELECTRON_VERSION ||
    lock.packages['node_modules/electron']?.version !== ELECTRON_VERSION
  )
    throw new Error(`Electron must be pinned to ${ELECTRON_VERSION}.`);
  const electronPackage = await manifest(join(root, 'node_modules/electron'));
  const electronDist = join(root, 'node_modules/electron/dist');
  if (
    electronPackage.version !== ELECTRON_VERSION ||
    (await inputText(join(electronDist, 'version'))).trim() !== ELECTRON_VERSION
  )
    throw new Error('Installed Electron package/distribution version mismatch.');
  electronIdentitySchema.parse(
    parseJson(
      run(
        join(electronDist, 'electron'),
        [
          '-p',
          'JSON.stringify({version:process.versions.electron,arch:process.arch,platform:process.platform})',
        ],
        { env: { ...environment, ELECTRON_RUN_AS_NODE: '1' } },
      ),
    ),
  );

  const explicitNode = process.env.ATELIER_BUILD_NODE ?? process.env.ATELIER_NODE_BINARY;
  if (
    process.env.ATELIER_BUILD_NODE &&
    process.env.ATELIER_NODE_BINARY &&
    resolve(process.env.ATELIER_BUILD_NODE) !== resolve(process.env.ATELIER_NODE_BINARY)
  )
    throw new Error('ATELIER_BUILD_NODE and ATELIER_NODE_BINARY disagree.');
  const candidates = explicitNode
    ? [resolve(explicitNode)]
    : [
        process.execPath,
        join(homedir(), `.local/share/mise/installs/node/${NODE_VERSION}/bin/node`),
        `/opt/node-v${NODE_VERSION}-linux-x64/bin/node`,
      ];
  let node: string | undefined;
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const identity = nodeIdentitySchema.safeParse(
      parseJson(
        run(candidate, [
          '-p',
          'JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform,glibc:process.report.getReport().header.glibcVersionRuntime})',
        ]),
      ),
    );
    if (identity.success) {
      node = await realpath(candidate);
      break;
    }
  }
  if (!node)
    throw new Error(
      `Install Node ${NODE_VERSION} Linux x64/glibc or set ATELIER_BUILD_NODE to its exact binary.`,
    );
  const nodeLicense = process.env.ATELIER_NODE_LICENSE
    ? resolve(process.env.ATELIER_NODE_LICENSE)
    : join(dirname(dirname(node)), 'LICENSE');
  if ((await hash(nodeLicense)) !== NODE_LICENSE_SHA256)
    throw new Error(
      `Node ${NODE_VERSION} LICENSE does not match the pinned distribution; set ATELIER_NODE_LICENSE.`,
    );
  for (const path of [
    'dist/client/index.html',
    'dist/client/vendor/pdfjs/pdf.worker.min.mjs',
    'desktop/main.mts',
    'desktop/preload.cts',
  ])
    if (!(await exists(join(root, path))))
      throw new Error(
        `Missing build input ${path}; finish desktop sources and run npm run build first.`,
      );

  const shunt = await shuntInput();
  const releasePackages = await closure(runtimeRoots, lock);
  const sdk = requirePackage(releasePackages, '@anthropic-ai/claude-agent-sdk');
  const cli = requirePackage(releasePackages, nativeCli);
  const orm = requirePackage(releasePackages, 'drizzle-orm');
  const sqliteDriver = requirePackage(releasePackages, 'better-sqlite3');
  for (const [name, version] of Object.entries(terminalRuntimeVersions)) {
    const dependency = requirePackage(releasePackages, name);
    if (project.dependencies[name] !== version || dependency.manifest.version !== version)
      throw new Error(`${name} must be pinned to ${version}.`);
    if (name === 'node-pty' && dependency.path !== ptyPackagePath)
      throw new Error(`PTY runtime must resolve from ${ptyPackagePath}.`);
  }
  for (const [item, version] of [
    [orm, ORM_VERSION],
    [sqliteDriver, SQLITE_DRIVER_VERSION],
  ] as const)
    if (project.dependencies[item.manifest.name] !== version || item.manifest.version !== version)
      throw new Error(`${item.manifest.name} must be pinned to ${version}.`);
  if (sdk.manifest.version !== cli.manifest.version || !sdk.manifest.claudeCodeVersion)
    throw new Error(
      'SDK and Linux x64 CLI package versions must match and declare the CLI version.',
    );
  await mkdir(runtime, { recursive: true });
  for (const name of electronFiles)
    await copy(join(electronDist, name), join(stage, name === 'electron' ? 'atelier' : name));
  // Some Electron Linux distributions omit the standalone ANGLE libraries.
  for (const name of ['libEGL.so', 'libGLESv2.so'])
    if (await exists(join(electronDist, name)))
      await copy(join(electronDist, name), join(stage, name));
  for (const name of await files(join(electronDist, 'locales'))) {
    if (!/^[A-Za-z0-9_-]+\.pak$/.test(name)) throw new Error(`Unexpected Electron locale: ${name}`);
    await copy(join(electronDist, 'locales', name), join(stage, 'locales', name));
  }
  const app = join(stage, 'resources/app');
  await mkdir(app, { recursive: true });
  const desktopInputs = {
    main: await compileDesktop('desktop/main.mts', join(app, 'main.mjs'), false),
    preload: await compileDesktop('desktop/preload.cts', join(app, 'preload.cjs'), true),
  };
  await putJson(join(app, 'package.json'), {
    name: project.name,
    productName: 'atelier',
    version: project.version,
    type: 'module',
    main: 'main.mjs',
    desktopName: 'atelier.desktop',
  });
  const entryPoints: string[] = [];
  for (const directory of ['server', 'shared'])
    for (const name of await files(join(root, directory)))
      if (name.endsWith('.ts') && !name.endsWith('.d.ts')) entryPoints.push(`${directory}/${name}`);
  // Keep import.meta.url beneath server/: it derives the installed runtime root.
  const runtimeBuild: BuildOptions = {
    absWorkingDir: root,
    entryPoints,
    outdir: runtime,
    outbase: root,
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: false,
    legalComments: 'eof',
    plugins: [inputPlugin],
  };
  await build(runtimeBuild);
  // The runtime copies this SDK plugin into the private directory for each run.
  const rtkPluginPath = 'resources/runtime/server/rtk-plugin/register.js';
  if (
    !entryPoints.includes('server/rtk-plugin/register.ts') ||
    !(await exists(join(stage, rtkPluginPath)))
  )
    throw new Error('Missing compiled RTK plugin payload.');
  const migrations: { path: string; sha256: string }[] = [];
  for (const path of RUNTIME_MIGRATIONS) {
    await copy(join(root, path), join(runtime, path));
    migrations.push({ path: `resources/runtime/${path}`, sha256: await hash(join(runtime, path)) });
  }
  await putJson(join(runtime, 'package.json'), {
    name: `${project.name}-runtime`,
    version: project.version,
    type: 'module',
    dependencies: Object.fromEntries(
      runtimeRoots.map((name) => [name, requirePackage(releasePackages, name).manifest.version]),
    ),
  });
  await copy(node, join(runtime, 'bin/node'), 0o755);
  await copy(nodeLicense, join(stage, 'resources/licenses/node-LICENSE'));
  // Copy only the pinned executable and legal texts, never gateway config or data.
  await copy(shunt, join(stage, SHUNT.path), 0o755);
  const shuntLicenseTexts: LicenseText[] = [];
  for (const text of SHUNT_LICENSES) {
    const source = join(root, 'docs/licenses', `shunt-${SHUNT.version}-${text.name}.txt`);
    if ((await rememberInput(source, 'shunt-license')) !== text.sha256)
      throw new Error(`Shunt ${SHUNT.version} ${text.name} does not match its pinned source.`);
    const destination = `resources/licenses/shunt/${text.name}`;
    await copy(source, join(stage, destination), 0o644);
    shuntLicenseTexts.push({ path: destination, sha256: text.sha256 });
  }
  const shuntRelease = { ...SHUNT, texts: shuntLicenseTexts };
  const rtk = await stageRtkRelease(root, work, stage, process.env.ATELIER_BUILD_RTK_ARCHIVE);
  if ((await rememberInput(rtk.inputs.archive, 'rtk-release-archive')) !== rtkRelease.archiveSha256)
    throw new Error('Pinned RTK archive changed while staging.');
  if ((await rememberInput(rtk.inputs.license, 'rtk-license')) !== rtkRelease.licenseSha256)
    throw new Error('Pinned RTK license changed while staging.');
  await rememberInput(join(root, 'scripts/linux/rtk.mts'), 'rtk-supply');
  const rtkResources = [
    rtk.release.path,
    rtk.release.launcher.path,
    ...rtk.release.texts.map((text) => text.path),
  ];
  for (const name of await files(join(root, 'dist/client'))) {
    if (
      name.split('/').some((part) => part.startsWith('.')) ||
      ![
        '.html',
        '.js',
        '.mjs',
        '.css',
        '.svg',
        '.png',
        '.webp',
        '.jpg',
        '.jpeg',
        '.woff',
        '.woff2',
        '.ttf',
        '.ico',
      ].includes(extname(name))
    )
      throw new Error(`Unallowlisted renderer resource: ${name}`);
    await copy(join(root, 'dist/client', name), join(runtime, 'dist/client', name));
  }
  for (const name of ['index.html', 'app.js', 'styles.css'])
    await copy(join(root, 'prototype', name), join(runtime, 'prototype', name));
  if (await exists(join(root, 'examples')))
    for (const name of await files(join(root, 'examples'))) {
      if (
        name.split('/').some((part) => part.startsWith('.')) ||
        !['.pdf', '.txt', '.md', '.json', '.png', '.jpg', '.jpeg', '.svg', '.csv'].includes(
          extname(name),
        )
      )
        throw new Error(`Unallowlisted example resource: ${name}`);
      await copy(join(root, 'examples', name), join(runtime, 'examples', name));
    }
  const stagedDependencies: StagedDependency[] = [];
  for (const item of releasePackages) {
    const selected = await packageFiles(join(root, item.path), item.manifest);
    if (!selected.includes('package.json'))
      throw new Error(`No package manifest selected: ${item.path}`);
    if (
      item.manifest.name === sqliteDriver.manifest.name &&
      (selected.filter((name) => extname(name) === '.node').length !== 1 ||
        !selected.includes(SQLITE_NATIVE_BINDING))
    )
      throw new Error('SQLite release must contain exactly the Linux x64 prebuild.');
    for (const name of selected)
      await copy(join(root, item.path, name), join(runtime, item.path, name));
    stagedDependencies.push({
      path: item.path,
      name: item.manifest.name,
      version: item.manifest.version,
      files: selected,
    });
  }

  // License evidence covers compiled renderer/desktop dependencies and the runtime.
  const licensedPackages = await closure(Object.keys(project.dependencies), lock, false);
  const licenseInventory: LicenseEntry[] = [];
  for (const item of licensedPackages) {
    const source = join(root, item.path);
    const names = (await readdir(source))
      .filter(
        (name) =>
          licenseName.test(name) ||
          (item.manifest.name.startsWith('@anthropic-ai/claude-agent-sdk') && name === 'README.md'),
      )
      .sort();
    if (item.manifest.name === 'playwright-core')
      names.push(...(await files(source)).filter((name) => playwrightNotice.test(name)).sort());
    const texts: LicenseText[] = [];
    for (const name of names) {
      if (!(await lstat(join(source, name))).isFile()) continue;
      const destination = `resources/licenses/${item.path}/${name}`;
      await copy(join(source, name), join(stage, destination));
      texts.push({ path: destination, sha256: await hash(join(stage, destination)) });
    }
    if (!texts.length) {
      const supplement = `${item.manifest.name}-${item.manifest.version}`;
      if (
        [
          `drizzle-orm-${ORM_VERSION}`,
          'fastdom-1.0.12',
          'react-remove-scroll-bar-2.3.8',
          'rehype-katex-7.0.1',
          'remark-math-6.0.0',
          'standardwebhooks-1.1.1',
          'strictdom-1.0.1',
        ].includes(supplement)
      ) {
        const destination = `resources/licenses/${item.path}/LICENSE-upstream.txt`;
        const source = join(root, 'docs/licenses', `${supplement}.txt`);
        if (
          item.manifest.name === 'drizzle-orm' &&
          (await rememberInput(source, 'orm-license')) !== ORM_LICENSE.sha256
        )
          throw new Error(
            `Drizzle ${ORM_VERSION} LICENSE does not match its pinned upstream source.`,
          );
        await copy(source, join(stage, destination));
        const text: LicenseText = {
          path: destination,
          sha256: await hash(join(stage, destination)),
        };
        if (item.manifest.name === 'drizzle-orm') text.source = ORM_LICENSE.source;
        texts.push(text);
      }
    }
    licenseInventory.push({
      name: item.manifest.name,
      version: item.manifest.version,
      dependencyPath: item.path,
      license: item.manifest.license ?? 'UNDECLARED',
      shippedAsRuntimePackage: stagedDependencies.some((dep) => dep.path === item.path),
      texts,
      missingLicenseText: texts.length === 0,
    });
  }
  for (const item of [orm, sqliteDriver])
    if (
      !licenseInventory.some(
        (entry) =>
          entry.dependencyPath === item.path &&
          entry.version === item.manifest.version &&
          entry.shippedAsRuntimePackage &&
          !entry.missingLicenseText,
      )
    )
      throw new Error(`Runtime license inventory is incomplete for ${item.manifest.name}.`);
  await putJson(join(stage, 'resources/licenses/inventory.json'), {
    application: {
      name: project.name,
      version: project.version,
      license: project.license ?? 'UNLICENSED',
    },
    electron: { version: ELECTRON_VERSION, files: ['LICENSE', 'LICENSES.chromium.html'] },
    node: {
      version: NODE_VERSION,
      path: 'resources/licenses/node-LICENSE',
      sha256: NODE_LICENSE_SHA256,
    },
    shunt: shuntRelease,
    rtk: rtk.release,
    packages: licenseInventory,
  });
  await copy(join(root, 'scripts/linux/atelier.desktop'), join(stage, 'atelier.desktop'));
  await copy(join(root, 'scripts/linux/atelier.svg'), join(stage, 'atelier.svg'));
  const esbuildManifest = await manifest(join(root, 'node_modules/esbuild'));
  const sqliteRelease = {
    orm: { name: orm.manifest.name, version: orm.manifest.version },
    driver: { name: sqliteDriver.manifest.name, version: sqliteDriver.manifest.version },
    nativeBinding: {
      path: `resources/runtime/${sqliteDriver.path}/${SQLITE_NATIVE_BINDING}`,
      sha256: await hash(join(runtime, sqliteDriver.path, SQLITE_NATIVE_BINDING)),
    },
    migrations,
  };
  const terminalRelease = terminalReleaseSchema.parse({
    supported: true,
    pty: { name: 'node-pty', version: terminalRuntimeVersions['node-pty'] },
    nativeBinding: {
      path: terminalNativeResource,
      sha256: await hash(join(stage, terminalNativeResource)),
    },
  });
  await putJson(join(stage, 'resources/release.json'), {
    schemaVersion: 1,
    name: project.name,
    version: project.version,
    platform: 'linux',
    arch: 'x64',
    libc: 'glibc',
    sourceDateEpoch: epoch,
    packaging: 'local Electron distribution + native makepkg (Forge not required)',
    electron: { version: ELECTRON_VERSION, sha256: await hash(join(stage, 'atelier')) },
    node: {
      version: NODE_VERSION,
      sha256: await hash(join(runtime, 'bin/node')),
      licenseSha256: NODE_LICENSE_SHA256,
    },
    shunt: shuntRelease,
    rtk: rtk.release,
    sqlite: sqliteRelease,
    terminal: terminalRelease,
    sdk: {
      version: sdk.manifest.version,
      cliPackage: nativeCli,
      cliVersion: sdk.manifest.claudeCodeVersion,
    },
    build: {
      lockSha256: await hash(join(root, 'package-lock.json')),
      esbuild: esbuildManifest.version,
      desktopInputs,
      runtimeSources: entryPoints,
    },
    runtimeDependencyRoots: runtimeRoots,
    runtimeDependencies: stagedDependencies,
  });
  // Record the packager and recipe before freezing the input inventory.
  const pkgbuildTemplate = await inputText(join(root, 'scripts/linux/PKGBUILD'), 'recipe');
  if (pkgbuildTemplate.split('@VERSION@').length !== 2)
    throw new Error('PKGBUILD must contain exactly one version placeholder.');
  await rememberInput(fileURLToPath(import.meta.url), 'packager');
  await rememberInput(join(root, 'scripts/linux/terminal-resources.mts'), 'packager');
  const terminalProbe = join(work, 'terminal-probe.mjs');
  await build({
    absWorkingDir: root,
    entryPoints: ['scripts/linux/terminal-probe.mts'],
    outfile: terminalProbe,
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: false,
    plugins: [inputPlugin],
  });
  const inputInventory = {
    schemaVersion: 1,
    sourceDateEpoch: epoch,
    sourcePolicy:
      'Current filesystem inputs only; no git operation or source snapshot is performed.',
    files: [...inputs.values()]
      .sort((a, b) => a.path.localeCompare(b.path, 'en'))
      .map((value) => ({
        ...value,
        // Temporary paths must not make release metadata vary between invocations.
        uses: value.uses
          .map((use) =>
            use.startsWith('copied:') ? use.replace(inputName(stage), 'atelier') : use,
          )
          .sort(),
      })),
  };
  await putJson(join(stage, 'resources/input-inventory.json'), inputInventory);
  const inventory: InventoryEntry[] = [];
  for (const name of await files(stage)) {
    if (
      name
        .split('/')
        .some(
          (part) =>
            part === '.data' || part.startsWith('.env') || part === '.claude' || part === '.config',
        )
    )
      throw new Error(`Private path entered release: ${name}`);
    const path = join(stage, name);
    const info = await stat(path);
    inventory.push({
      path: name,
      bytes: info.size,
      mode: (info.mode & 0o777).toString(8),
      sha256: await hash(path),
    });
  }
  const stagedShunt = inventory.find((item) => item.path === SHUNT.path);
  if (stagedShunt?.sha256 !== SHUNT.sha256 || stagedShunt.mode !== '755')
    throw new Error('Staged Shunt checksum or executable mode does not match the release pin.');
  const stagedRtk = inventory.find((item) => item.path === rtk.release.path);
  const stagedRtkLauncher = inventory.find((item) => item.path === rtk.release.launcher.path);
  if (
    stagedRtk?.sha256 !== rtkRelease.binarySha256 ||
    stagedRtk.mode !== '755' ||
    stagedRtkLauncher?.sha256 !== createHash('sha256').update(rtkLauncher).digest('hex') ||
    stagedRtkLauncher.mode !== '755'
  )
    throw new Error('Staged RTK executable or launcher does not match its pinned bytes and mode.');
  for (const text of rtk.release.texts)
    if (inventory.find((item) => item.path === text.path)?.sha256 !== text.sha256)
      throw new Error('Staged RTK original license does not match its pin.');
  const resourceInventory = {
    schemaVersion: 1,
    sourceDateEpoch: epoch,
    platform: 'linux-x64-glibc',
    totalBytes: inventory.reduce((sum, item) => sum + item.bytes, 0),
    selfExcluded: 'resources/resource-inventory.json',
    files: inventory,
  };
  await putJson(join(stage, 'resources/resource-inventory.json'), resourceInventory);
  await normalize(stage);
  for (const path of [
    'resources/app/main.mjs',
    'resources/app/preload.cjs',
    'resources/runtime/server/main.js',
    rtkPluginPath,
  ])
    run(join(runtime, 'bin/node'), ['--check', join(stage, path)]);
  const runtimeIdentity = z
    .object({
      node: z.literal(NODE_VERSION),
      sqlite: z.literal(true),
      betterSqlite3: z.literal(true),
      drizzle: z.literal(true),
    })
    .parse(
      parseJson(
        run(
          join(runtime, 'bin/node'),
          [
            '--input-type=module',
            '-e',
            `
              const { registerHooks } = await import('node:module');
              const stagedRoot = new URL('./', import.meta.url).href;
              registerHooks({
                resolve(specifier, context, next) {
                  const result = next(specifier, context);
                  if (result.url.startsWith('file:') && !result.url.startsWith(stagedRoot))
                    throw new Error('Runtime dependency resolved outside the staged package: ' + specifier);
                  return result;
                }
              });
              await import('./server/app.js');
              const { Store } = await import('./server/store.js');
              const fresh = new Store(process.argv[1]);
              fresh.close();
              await import('playwright-core');
              await import('@anthropic-ai/claude-agent-sdk');
              await import('@anthropic-ai/sdk');
              const {DatabaseSync}=await import('node:sqlite');
              const db=new DatabaseSync(':memory:');
              const row=db.prepare('select 1 as ok').get();
              db.close();
              const {default:Database}=await import('better-sqlite3');
              const {drizzle}=await import('drizzle-orm/better-sqlite3');
              const {sqliteTable,integer}=await import('drizzle-orm/sqlite-core');
              const native=new Database(':memory:');
              native.exec('CREATE TABLE probe(ok INTEGER NOT NULL) STRICT');
              const probe=sqliteTable('probe',{ok:integer('ok').notNull()});
              const orm=drizzle(native);
              orm.insert(probe).values({ok:1}).run();
              const nativeRow=native.prepare('SELECT ok FROM probe').get();
              const ormRow=orm.select().from(probe).get();
              native.close();
              console.log(JSON.stringify({node:process.versions.node,sqlite:row?.ok===1,
                betterSqlite3:nativeRow?.ok===1,drizzle:ormRow?.ok===1}));
            `,
            join(work, 'store-probe'),
          ],
          { cwd: runtime },
        ),
      ),
    );
  const terminalIdentity = terminalProbeResultSchema.parse(
    parseJson(
      run(
        join(runtime, 'bin/node'),
        ['--input-type=module', '-e', await readFile(terminalProbe, 'utf8')],
        { cwd: runtime, timeout: 20_000 },
      ),
    ),
  );
  if (terminalIdentity.node !== NODE_VERSION)
    throw new Error(`Terminal probe must use staged Node ${NODE_VERSION}.`);
  const cliOutput = run(join(runtime, 'node_modules', nativeCli, 'claude'), ['--version'], {
    cwd: runtime,
  });
  if (cliOutput !== `${sdk.manifest.claudeCodeVersion} (Claude Code)`)
    throw new Error(`Staged SDK CLI identity mismatch: ${cliOutput}`);
  console.log(
    `Verified staged Node ${runtimeIdentity.node}, SQLite, better-sqlite3 ${SQLITE_DRIVER_VERSION}, Drizzle ${ORM_VERSION}, PTY/screen/WebSocket, runtime imports and SDK CLI ${sdk.manifest.claudeCodeVersion}.`,
  );

  const archiveName = `atelier-${project.version}-linux-x64.tar.zst`;
  const packageName = `atelier-${project.version}-1-x86_64.pkg.tar.zst`;
  console.log(
    `Staged ${inventory.length + 1} files, ${releasePackages.length} runtime packages; creating archives…`,
  );
  run('tar', [
    '--sort=name',
    '--format=gnu',
    `--mtime=@${epoch}`,
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--use-compress-program=zstd -q -T1 -10',
    '-cf',
    join(artifacts, archiveName),
    '-C',
    work,
    'atelier',
  ]);
  const makeDirectory = join(work, 'makepkg');
  await mkdir(makeDirectory, { recursive: true });
  await put(
    join(makeDirectory, 'PKGBUILD'),
    pkgbuildTemplate.replace('@VERSION@', project.version),
  );
  const config = join(work, 'makepkg.conf');
  await put(
    config,
    `source /etc/makepkg.conf\nPKGEXT='.pkg.tar.zst'\nPACKAGER='atelier local release'\nCOMPRESSZST=(zstd -c -T1 -10 -)\nBUILDENV=(!distcc !color !ccache !check !sign)\nOPTIONS=(!strip docs !libtool !staticlibs emptydirs !zipman !purge !debug !lto)\n`,
  );
  const makepkgOutput = run('makepkg', ['--config', config, '--nodeps', '--nocheck', '--nosign'], {
    cwd: makeDirectory,
    env: {
      ...environment,
      ATELIER_STAGE: stage,
      PKGDEST: artifacts,
      BUILDDIR: makeDirectory,
      SRCDEST: makeDirectory,
      SRCPKGDEST: makeDirectory,
      LOGDEST: makeDirectory,
      XDG_CONFIG_HOME: join(work, 'empty-config'),
      MAKEPKG_CONF: config,
    },
  });
  const portableListing = run('tar', ['-tf', join(artifacts, archiveName)]).split('\n');
  const archListing = run('bsdtar', ['-tf', join(artifacts, packageName)]).split('\n');
  for (const path of [
    'atelier/atelier',
    'atelier/resources/app/main.mjs',
    'atelier/resources/app/preload.cjs',
    'atelier/resources/runtime/bin/node',
    'atelier/resources/runtime/server/main.js',
    'atelier/resources/runtime/dist/client/index.html',
    'atelier/resources/runtime/dist/client/vendor/pdfjs/pdf.worker.min.mjs',
    'atelier/resources/licenses/inventory.json',
    ...[SHUNT.path, ...shuntLicenseTexts.map((text) => text.path)].map((path) => `atelier/${path}`),
    ...[...rtkResources, rtkPluginPath].map((path) => `atelier/${path}`),
    'atelier/resources/input-inventory.json',
    `atelier/resources/runtime/node_modules/${nativeCli}/claude`,
    `atelier/${sqliteRelease.nativeBinding.path}`,
    `atelier/${terminalRelease.nativeBinding.path}`,
    ...migrations.map((migration) => `atelier/${migration.path}`),
  ])
    if (!portableListing.includes(path)) throw new Error(`Portable archive is missing ${path}`);
  for (const path of [
    '.PKGINFO',
    'opt/atelier/atelier',
    `opt/atelier/${sqliteRelease.nativeBinding.path}`,
    `opt/atelier/${terminalRelease.nativeBinding.path}`,
    ...migrations.map((migration) => `opt/atelier/${migration.path}`),
    ...[SHUNT.path, ...shuntLicenseTexts.map((text) => text.path)].map(
      (path) => `opt/atelier/${path}`,
    ),
    ...[...rtkResources, rtkPluginPath].map((path) => `opt/atelier/${path}`),
    'usr/bin/atelier',
    'usr/share/applications/atelier.desktop',
    'usr/share/licenses/atelier',
  ])
    if (!archListing.includes(path)) throw new Error(`Arch package is missing ${path}`);
  for (const listing of [portableListing, archListing])
    for (const name of listing) {
      const plain = name.endsWith('/') ? name.slice(0, -1) : name;
      if (
        !safeRelative(plain) ||
        /(?:^|\/)(?:\.data|\.env(?:\.[^/]*)?|\.claude|\.config)(?:\/|$)/.test(name)
      )
        throw new Error(`Invalid/private path entered an archive: ${name}`);
    }
  verifyRtkArchive(root, join(artifacts, archiveName), 'atelier');
  verifyRtkArchive(root, join(artifacts, packageName), 'opt/atelier', 'bsdtar');
  const pkgInfo = run('bsdtar', ['-xOf', join(artifacts, packageName), '.PKGINFO']);
  for (const expected of [
    'pkgname = atelier',
    `pkgver = ${project.version}-1`,
    'arch = x86_64',
    'license = Apache-2.0',
  ])
    if (!pkgInfo.split('\n').includes(expected))
      throw new Error(`Arch metadata is missing ${expected}`);
  const packageInfo = run('pacman', ['-Qip', join(artifacts, packageName)]);
  await put(join(artifacts, 'portable-files.txt'), `${portableListing.join('\n')}\n`);
  await put(join(artifacts, 'arch-files.txt'), `${archListing.join('\n')}\n`);
  await put(join(artifacts, 'arch-package-info.txt'), `${packageInfo}\n`);
  await put(join(artifacts, 'makepkg.log'), `${makepkgOutput}\n`);
  await putJson(join(artifacts, 'resource-inventory.json'), resourceInventory);
  // These are generated outputs, so do not add them to the source input inventory.
  for (const [from, to] of [
    ['resources/licenses/inventory.json', 'license-inventory.json'],
    ['resources/release.json', 'release.json'],
    ['resources/input-inventory.json', 'input-inventory.json'],
  ]) {
    if (!from || !to) throw new Error('Incomplete metadata copy mapping.');
    await copyFile(join(stage, from), join(artifacts, to));
  }
  const releaseSize = {
    version: project.version,
    sourceDateEpoch: epoch,
    stagedBytes:
      (await stat(join(stage, 'resources/resource-inventory.json'))).size +
      resourceInventory.totalBytes,
    stagedFiles: inventory.length + 1,
    artifacts: await Promise.all(
      [archiveName, packageName].map(async (name) => ({
        name,
        bytes: (await stat(join(artifacts, name))).size,
        sha256: await hash(join(artifacts, name)),
      })),
    ),
    listingVerified: true,
    stagedChecks: {
      node: runtimeIdentity.node,
      sqlite: runtimeIdentity.sqlite,
      betterSqlite3: runtimeIdentity.betterSqlite3,
      drizzle: runtimeIdentity.drizzle,
      sqliteResources: sqliteRelease,
      terminalResources: terminalRelease,
      terminal: terminalIdentity,
      runtimeImports: true,
      sdkCli: cliOutput,
      shunt: { version: SHUNT.version, sha256: stagedShunt.sha256, mode: stagedShunt.mode },
      rtk: {
        version: rtkRelease.version,
        sha256: stagedRtk.sha256,
        mode: stagedRtk.mode,
        launcher: rtk.release.launcher,
        originalLicenseVerified: true,
        portableAndArchBytesVerified: true,
        executionVerified: false,
        plugin: { path: rtkPluginPath, sha256: await hash(join(stage, rtkPluginPath)) },
      },
    },
    missingLicenseTexts: licenseInventory
      .filter((item) => item.missingLicenseText)
      .map((item) => `${item.name}@${item.version}`),
    limitations: [
      'Unsigned local P1 sample. No root install or system menu cache mutation performed.',
      'Portable means relocatable on compatible Linux x64/glibc hosts; system shared libraries are required.',
      'Reproducibility requires identical input bytes, pinned runtimes, SOURCE_DATE_EPOCH and Arch tools/package database; makepkg build paths may vary.',
      'Application source has no declared license; missing upstream license texts are enumerated explicitly.',
    ],
  };
  await putJson(join(artifacts, 'size.json'), releaseSize);
  const checksumFiles = [
    archiveName,
    packageName,
    'resource-inventory.json',
    'license-inventory.json',
    'input-inventory.json',
    'release.json',
    'size.json',
    'portable-files.txt',
    'arch-files.txt',
    'arch-package-info.txt',
    'makepkg.log',
  ];
  await put(
    join(artifacts, 'SHA256SUMS'),
    `${(await Promise.all(checksumFiles.map(async (name) => `${await hash(join(artifacts, name))}  ${name}`))).join('\n')}\n`,
  );
  await verifyInputs();
  // Publish only after every build, archive, dependency and input check succeeds.
  // The lock covers promotion; old output survives all earlier failures.
  const previousStage = join(work, 'previous-atelier');
  const publishedStage = join(output, 'atelier');
  if (await exists(publishedStage)) {
    const info = await lstat(publishedStage);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Existing stage must be a real directory: ${publishedStage}`);
    await rename(publishedStage, previousStage);
  }
  try {
    await rename(stage, publishedStage);
  } catch (error: unknown) {
    if (await exists(previousStage)) await rename(previousStage, publishedStage);
    throw error;
  }
  for (const name of [...checksumFiles, 'SHA256SUMS'])
    await rename(join(artifacts, name), join(output, name));
  console.log(JSON.stringify(releaseSize, null, 2));
  return [join(output, archiveName), join(output, packageName)];
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('This packager requires Linux x64/glibc.');
  if (process.getuid?.() === 0)
    throw new Error('Run packaging as an ordinary user; no root installation is performed.');
  if (
    !/^\d+$/.test(epochText) ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    epoch > 8_640_000_000_000
  )
    throw new Error(
      'SOURCE_DATE_EPOCH must be a positive integer representable as a filesystem timestamp.',
    );
  for (const tool of ['makepkg', 'pacman', 'tar', 'zstd', 'bsdtar']) run('which', [tool]);
  await safeOutputDirectory(join(root, 'dist'));
  await safeOutputDirectory(output);
  const lockDirectory = join(output, '.package-lock');
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error(
        `Another package run holds ${lockDirectory}. If its process has stopped, remove that lock before retrying.`,
      );
    throw error;
  }
  let work: string | undefined;
  try {
    await putJson(join(lockDirectory, 'owner.json'), {
      pid: process.pid,
      started: new Date().toISOString(),
    });
    work = await mkdtemp(join(output, '.package-'));
    const archives = await packageRelease(work);
    console.log(`Archives:\n${archives.join('\n')}`);
  } finally {
    try {
      if (work) await rm(work, { recursive: true, force: true });
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
    }
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
