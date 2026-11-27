/**
 * @file 生成 Windows x64 和 macOS arm64 桌面候选 ZIP。
 * @implementation 替换平台资源和 SQLite，排除 Linux PTY 并同步非终端候选清单，核对迁移、许可证与归档。
 * @updated 2026-11-26T01:30:00+08:00
 */
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  isPtyRuntimeResource,
  ptyPackagePath,
  terminalPreviewMetadata,
  terminalReleaseSchema,
} from './linux/terminal-resources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const linux = join(root, 'dist/linux/atelier');
const electronVersion = '45.4.1';
const nodeVersion = '24.21.0';
const packagerVersion = '20.3.0';
const sqlitePackage = 'node_modules/better-sqlite3';
const linuxSqliteBinding = `resources/runtime/${sqlitePackage}/prebuilds/linux-x64.node`;
const migrationPaths = [
  'resources/runtime/server/db/migrations/0006-session-snapshot-indexes.sql',
  'resources/runtime/server/db/migrations/0007-subagents.sql',
  'resources/runtime/server/db/migrations/0008-git-worktrees.sql',
  'resources/runtime/server/db/migrations/0009-git-commit-operations.sql',
  'resources/runtime/server/db/migrations/0010-git-commit-operation-lifecycle.sql',
  'resources/runtime/server/db/migrations/0011-runtime-hotpath-indexes.sql',
] as const;
const targets = {
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    nodeDistro: 'win-x64',
    nodeArchive: 'zip',
    nodeEntry: 'node.exe',
    binary: 'node.exe',
    cli: 'claude.exe',
    electronSha: '2ba6223afa9121f42831fefe92c434334907540165294fc56697449d12e7cfe9',
    nodeSha: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
    binaryFormat: /PE32\+.*x86-64/,
    sqliteFormat: /PE32\+.*\(DLL\).*x86-64/,
  },
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    nodeDistro: 'darwin-arm64',
    nodeArchive: 'tar.gz',
    nodeEntry: 'bin/node',
    binary: 'node',
    cli: 'claude',
    electronSha: 'd080c3b05a01bd16137f2c12ab9ebf083c577757fe846844ba325bafa8e8bdf4',
    nodeSha: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
    binaryFormat: /^Mach-O 64-bit (?=.*\barm64\b)(?=.*\bexecutable\b)/,
    sqliteFormat: /^Mach-O 64-bit (?=.*\barm64\b)(?=.*\bbundle\b)/,
  },
} as const;

const marker = z.string().regex(/^[a-f0-9]{64}$/);
const resourceManifest = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      bytes: z.int().nonnegative(),
      sha256: marker,
      mode: z.string().regex(/^[0-7]{3}$/),
    }),
  ),
});
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

async function hash(
  path: string,
  algorithm = 'sha256',
  encoding: 'hex' | 'base64' = 'hex',
): Promise<string> {
  const digest = createHash(algorithm);
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest(encoding);
}

async function extract(
  archive: string,
  member: string,
  destination: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const child = spawn('bsdtar', ['-xOf', archive, member], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const completed = once(child, 'close');
  try {
    await pipeline(child.stdout, createWriteStream(destination, { flags: 'wx', mode }));
  } finally {
    assert.deepEqual(await completed, [0, null], `Unable to extract ${member}`);
  }
  assert.ok((await stat(destination)).size > 0, `Empty member ${member}`);
}

async function verifyBinary(path: string, format: RegExp): Promise<string> {
  const description = execFileSync('file', ['-b', path], { encoding: 'utf8' }).trim();
  assert.match(description, format, `Unexpected executable format for ${basename(path)}`);
  return description;
}

const [targetArg, downloadsArg, toolsArg] = process.argv.slice(2);
const targetName = z.enum(['win32-x64', 'darwin-arm64']).parse(targetArg);
assert.ok(
  downloadsArg && toolsArg,
  'Usage: tsx scripts/package-platform-preview.mts <target> <verified downloads> <Packager npm prefix>',
);
const target = targets[targetName];
const downloads = resolve(downloadsArg);
const packagerRoot = resolve(toolsArg, 'node_modules/@electron/packager');
const manifest = z
  .object({ version: z.literal(packagerVersion) })
  .parse(await readJson(join(packagerRoot, 'package.json')));
const release = z
  .object({
    name: z.string(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    electron: z.object({ version: z.literal(electronVersion) }),
    node: z.object({ version: z.literal(nodeVersion) }),
    terminal: terminalReleaseSchema.optional(),
    sdk: z.object({
      version: z.string(),
      cliPackage: z.literal('@anthropic-ai/claude-agent-sdk-linux-x64'),
      cliVersion: z.string(),
    }),
    sqlite: z.object({
      orm: z.object({ name: z.literal('drizzle-orm'), version: z.literal('0.45.4') }),
      driver: z.object({ name: z.literal('better-sqlite3'), version: z.literal('13.2.0') }),
      nativeBinding: z.object({ path: z.literal(linuxSqliteBinding), sha256: marker }),
      migrations: z
        .array(z.object({ path: z.enum(migrationPaths), sha256: marker }))
        .length(migrationPaths.length)
        .refine((items) => new Set(items.map((item) => item.path)).size === migrationPaths.length),
    }),
    runtimeDependencyRoots: z.array(z.string()),
    runtimeDependencies: z.array(
      z.object({
        path: z.string(),
        name: z.string(),
        version: z.string(),
        files: z.array(z.string()),
      }),
    ),
  })
  .parse(await readJson(join(linux, 'resources/release.json')));
const lock = z
  .object({
    packages: z.record(
      z.string(),
      z.object({ integrity: z.string().optional(), version: z.string().optional() }),
    ),
  })
  .parse(await readJson(join(root, 'package-lock.json')));
const cliPackage = `@anthropic-ai/claude-agent-sdk-${targetName}`;
for (const pkg of [release.sqlite.orm, release.sqlite.driver]) {
  assert.equal(lock.packages[`node_modules/${pkg.name}`]?.version, pkg.version);
  const dependency = release.runtimeDependencies.find(
    (item) => item.path === `node_modules/${pkg.name}`,
  );
  assert.equal(dependency?.name, pkg.name);
  assert.equal(dependency?.version, pkg.version);
}
const sqliteDependency = release.runtimeDependencies.find((item) => item.path === sqlitePackage);
assert.ok(sqliteDependency);
assert.deepEqual(
  sqliteDependency.files.filter((path) => path.endsWith('.node')),
  ['prebuilds/linux-x64.node'],
);
const installedSqlite = z
  .object({ name: z.literal('better-sqlite3'), version: z.literal('13.2.0') })
  .parse(await readJson(join(root, sqlitePackage, 'package.json')));
assert.equal(installedSqlite.version, release.sqlite.driver.version);
const lockedCli = lock.packages[`node_modules/${cliPackage}`];
assert.equal(lockedCli?.version, release.sdk.version);
const cliIntegrity = lockedCli?.integrity;
assert.ok(cliIntegrity && cliIntegrity.startsWith('sha512-'));
const electronZip = join(downloads, `electron-v${electronVersion}-${targetName}.zip`);
const nodeBase = `node-v${nodeVersion}-${target.nodeDistro}`;
const nodeZip = join(downloads, `${nodeBase}.${target.nodeArchive}`);
const sdkZip = join(downloads, `sdk-${targetName}.tgz`);
assert.equal(await hash(electronZip), target.electronSha);
assert.equal(await hash(nodeZip), target.nodeSha);
assert.equal(await hash(sdkZip, 'sha512', 'base64'), cliIntegrity.slice('sha512-'.length));

const output = join(root, 'dist/platform-previews');
await mkdir(output, { recursive: true });
const working = await mkdtemp(join(output, `${targetName}-`));
const inputs = join(working, 'inputs');
const inventory = resourceManifest.parse(
  await readJson(join(linux, 'resources/resource-inventory.json')),
);
const nativeRoot = release.sdk.cliPackage;
let sharedFiles = 0;
for (const resource of inventory.files) {
  if (!/^resources\/(app|runtime|licenses)\//.test(resource.path)) continue;
  if (
    resource.path.includes(nativeRoot) ||
    isPtyRuntimeResource(resource.path) ||
    resource.path === linuxSqliteBinding ||
    resource.path.startsWith('resources/runtime/bin/') ||
    ['resources/licenses/node-LICENSE', 'resources/licenses/inventory.json'].includes(resource.path)
  )
    continue;
  const segments = resource.path.split('/');
  assert.ok(
    segments.every(
      (part) =>
        part !== '..' &&
        part !== '.' &&
        !part.includes('\\') &&
        !part.includes(':') &&
        part.length > 0,
    ),
  );
  assert.ok(
    !/\.(?:node|so|dylib|dll|exe)$/i.test(resource.path),
    `Unexpected platform binary ${resource.path}`,
  );
  const from = join(linux, resource.path);
  assert.equal(await hash(from), resource.sha256, resource.path);
  const to = join(inputs, ...segments.slice(1));
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  await chmod(to, Number.parseInt(resource.mode, 8));
  sharedFiles++;
}
assert.ok(sharedFiles > 100);
const terminalPreview = terminalPreviewMetadata(
  await readJson(join(inputs, 'runtime/package.json')),
  release,
);
await writeFile(
  join(inputs, 'runtime/package.json'),
  JSON.stringify(terminalPreview.runtimePackage, null, 2) + '\n',
);
for (const migration of release.sqlite.migrations)
  assert.equal(
    await hash(join(inputs, migration.path.slice('resources/'.length))),
    migration.sha256,
  );
const sqliteBinding = `prebuilds/${targetName}.node`;
const sqliteSource = join(root, sqlitePackage, sqliteBinding);
const sqliteDestination = join(inputs, 'runtime', sqlitePackage, sqliteBinding);
const sqliteSha256 = await hash(sqliteSource);
assert.equal(await hash(join(linux, linuxSqliteBinding)), release.sqlite.nativeBinding.sha256);
assert.equal(
  await hash(join(root, sqlitePackage, 'package.json')),
  await hash(join(inputs, 'runtime', sqlitePackage, 'package.json')),
  'Target prebuild must come from the same driver package manifest',
);
await mkdir(dirname(sqliteDestination), { recursive: true });
await copyFile(sqliteSource, sqliteDestination);
await chmod(sqliteDestination, 0o644);
assert.equal(await hash(sqliteDestination), sqliteSha256);
assert.deepEqual(await readdir(dirname(sqliteDestination)), [`${targetName}.node`]);
const sqliteRelease = {
  ...release.sqlite,
  nativeBinding: {
    path: `resources/runtime/${sqlitePackage}/${sqliteBinding}`,
    sha256: sqliteSha256,
  },
};
const nativeCliPath = join(inputs, 'runtime', 'node_modules', cliPackage);
for (const member of ['package.json', 'README.md', 'LICENSE.md', target.cli]) {
  await extract(
    sdkZip,
    `package/${member}`,
    join(nativeCliPath, member),
    member === target.cli ? 0o755 : 0o644,
  );
}
const sdk = z
  .object({
    name: z.literal(cliPackage),
    version: z.literal(release.sdk.version),
    os: z.array(z.string()),
    cpu: z.array(z.string()),
    license: z.string(),
  })
  .parse(await readJson(join(nativeCliPath, 'package.json')));
assert.deepEqual(sdk.os, [target.platform]);
assert.deepEqual(sdk.cpu, [target.arch]);
const nodeLicense = join(inputs, 'licenses/node-LICENSE');
await extract(
  nodeZip,
  `${nodeBase}/${target.nodeEntry}`,
  join(inputs, 'runtime/bin', target.binary),
  0o755,
);
await extract(nodeZip, `${nodeBase}/LICENSE`, nodeLicense, 0o644);
const licenseSchema = z.object({
  application: z.unknown(),
  electron: z.unknown(),
  node: z.object({ sha256: marker }).loose(),
  packages: z.array(
    z
      .object({
        name: z.string(),
        version: z.string(),
        shippedAsRuntimePackage: z.boolean(),
        missingLicenseText: z.boolean(),
        texts: z.array(z.object({ path: z.string(), sha256: marker, source: z.url().optional() })),
      })
      .loose(),
  ),
});
const notices = licenseSchema.parse(
  await readJson(join(linux, 'resources/licenses/inventory.json')),
);
for (const pkg of [release.sqlite.orm, release.sqlite.driver]) {
  const entry = notices.packages.find((item) => item.name === pkg.name);
  assert.equal(entry?.version, pkg.version);
  assert.equal(entry?.shippedAsRuntimePackage, true);
  assert.equal(entry?.missingLicenseText, false);
  assert.ok(entry && entry.texts.length > 0);
  for (const text of entry.texts)
    assert.equal(await hash(join(inputs, text.path.slice('resources/'.length))), text.sha256);
}
const licenses = [];
for (const member of ['README.md', 'LICENSE.md']) {
  const path = `resources/licenses/node_modules/${cliPackage}/${member}`;
  const destination = join(inputs, path.slice('resources/'.length));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(nativeCliPath, member), destination);
  licenses.push({ path, sha256: await hash(destination) });
}
await writeFile(
  join(inputs, 'licenses/inventory.json'),
  JSON.stringify(
    {
      ...notices,
      node: { ...notices.node, sha256: await hash(nodeLicense) },
      packages: [
        ...notices.packages
          .filter((pkg) => pkg.name !== nativeRoot)
          .map((pkg) =>
            pkg.name === 'node-pty' ? { ...pkg, shippedAsRuntimePackage: false } : pkg,
          ),
        {
          name: cliPackage,
          version: sdk.version,
          dependencyPath: `node_modules/${cliPackage}`,
          license: sdk.license,
          shippedAsRuntimePackage: true,
          missingLicenseText: false,
          texts: licenses,
        },
      ],
    },
    null,
    2,
  ) + '\n',
);

const frameworkOutput = join(working, 'packaged');
const built = spawnSync(
  process.execPath,
  [
    join(packagerRoot, 'bin/electron-packager.mjs'),
    join(inputs, 'app'),
    'atelier',
    `--platform=${target.platform}`,
    `--arch=${target.arch}`,
    `--electron-version=${electronVersion}`,
    `--electron-zip-dir=${downloads}`,
    `--out=${frameworkOutput}`,
    '--no-asar',
    '--no-prune',
    `--extra-resource=${join(inputs, 'runtime')}`,
    `--extra-resource=${join(inputs, 'licenses')}`,
  ],
  { stdio: 'inherit' },
);
if (built.error) throw built.error;
assert.equal(built.status, 0, 'Electron Packager failed');
const packaged = join(frameworkOutput, `atelier-${targetName}`);
const app = target.platform === 'darwin' ? join(packaged, 'atelier.app') : packaged;
const resources =
  target.platform === 'darwin' ? join(app, 'Contents/Resources') : join(app, 'resources');
const launcher =
  target.platform === 'darwin' ? join(app, 'Contents/MacOS/atelier') : join(app, 'atelier.exe');
const binaries = {
  electron: await verifyBinary(launcher, target.binaryFormat),
  node: await verifyBinary(join(resources, 'runtime/bin', target.binary), target.binaryFormat),
  cli: await verifyBinary(
    join(resources, 'runtime/node_modules', cliPackage, target.cli),
    target.binaryFormat,
  ),
  sqlite: await verifyBinary(
    join(resources, 'runtime', sqlitePackage, sqliteBinding),
    target.sqliteFormat,
  ),
};
assert.equal(await hash(join(resources, 'runtime', sqlitePackage, sqliteBinding)), sqliteSha256);
assert.deepEqual(await readdir(join(resources, 'runtime', sqlitePackage, 'prebuilds')), [
  `${targetName}.node`,
]);
const runtimeDependencies = terminalPreview.runtimeDependencies.map((item) => {
  if (item.path === sqlitePackage)
    return {
      ...item,
      files: item.files
        .filter((path) => !path.endsWith('.node'))
        .concat(sqliteBinding)
        .sort(),
    };
  if (item.name === nativeRoot)
    return {
      ...item,
      path: `node_modules/${cliPackage}`,
      name: cliPackage,
      files: ['package.json', 'README.md', 'LICENSE.md', target.cli].sort(),
    };
  return item;
});
for (const item of runtimeDependencies)
  for (const path of item.files)
    assert.ok(
      (await stat(join(resources, 'runtime', item.path, path))).isFile(),
      `${item.path}/${path}`,
    );
for (const migration of sqliteRelease.migrations)
  assert.equal(
    await hash(join(resources, migration.path.slice('resources/'.length))),
    migration.sha256,
  );
await writeFile(
  join(resources, 'release.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      name: release.name,
      version: release.version,
      platform: target.platform,
      arch: target.arch,
      packaging: 'Electron Packager platform preview',
      electron: { version: electronVersion, sha256: await hash(launcher) },
      node: {
        version: nodeVersion,
        sha256: await hash(join(resources, 'runtime/bin', target.binary)),
        licenseSha256: await hash(nodeLicense),
      },
      sdk: { ...release.sdk, cliPackage },
      sqlite: sqliteRelease,
      terminal: terminalPreview.terminal,
      runtimeDependencyRoots: terminalPreview.runtimeDependencyRoots,
      runtimeDependencies,
    },
    null,
    2,
  ) + '\n',
);
for (const name of [
  'app/main.mjs',
  'app/preload.cjs',
  'runtime/server/main.js',
  'runtime/dist/client/index.html',
  'licenses/inventory.json',
  'release.json',
  ...migrationPaths.map((path) => path.slice('resources/'.length)),
  `runtime/${sqlitePackage}/${sqliteBinding}`,
])
  assert.ok((await stat(join(resources, name))).isFile(), name);
assert.equal(
  await stat(join(resources, 'runtime', ptyPackagePath)).then(
    () => true,
    () => false,
  ),
  false,
  'Non-Terminal candidates must not contain node-pty',
);
if (target.platform === 'darwin')
  assert.ok(
    (await readdir(join(app, 'Contents/Frameworks'))).some((name) =>
      name.startsWith('atelier Helper'),
    ),
  );
const archive = join(working, `atelier-${release.version}-${targetName}-preview.zip`);
execFileSync('zip', ['-q', '-r', '-y', archive, basename(app)], {
  cwd: dirname(app),
  stdio: 'inherit',
});
execFileSync('zip', ['-T', archive], { stdio: 'inherit' });
const evidence = {
  target: targetName,
  validation: 'archive and executable inspection on Linux',
  nativeExecutionVerified: false,
  electron: electronVersion,
  node: nodeVersion,
  sdk: { ...release.sdk, cliPackage },
  sqlite: sqliteRelease,
  terminal: terminalPreview.terminal,
  targetCli: cliPackage,
  packager: manifest.version,
  sharedFiles,
  binaries,
  archive: {
    name: basename(archive),
    bytes: (await stat(archive)).size,
    sha256: await hash(archive),
  },
};
await writeFile(join(working, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(archive);
