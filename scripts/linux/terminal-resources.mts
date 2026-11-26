/**
 * @file 定义终端发行资源与非 Linux 候选的裁剪规则。
 * @implementation 只选取 Linux x64 PTY 运行文件，核对 ELF 和清单，并同步候选包的依赖声明。
 * @updated 2026-11-26T01:30:00+08:00
 */
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const terminalRuntimeVersions = {
  'node-pty': '1.1.0',
  ws: '8.23.0',
  '@xterm/headless': '6.0.0',
  '@xterm/addon-serialize': '0.14.0',
} as const;
export const ptyPackagePath = 'node_modules/node-pty';
export const ptyNativeBinding = 'build/Release/pty.node';
export const terminalNativeResource = `resources/runtime/${ptyPackagePath}/${ptyNativeBinding}`;

export const terminalReleaseSchema = z.strictObject({
  supported: z.literal(true),
  pty: z.strictObject({ name: z.literal('node-pty'), version: z.literal('1.1.0') }),
  nativeBinding: z.strictObject({
    path: z.literal(terminalNativeResource),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
});

export const terminalProbeResultSchema = z.strictObject({
  node: z.string().min(1),
  platform: z.literal('linux'),
  arch: z.literal('x64'),
  napi: z.string().min(1),
  modules: z.string().min(1),
  pty: z.strictObject({
    tty: z.literal(true),
    cwd: z.literal(true),
    cols: z.literal(91),
    rows: z.literal(37),
    exitCode: z.literal(0),
  }),
  headlessSnapshot: z.literal(true),
  websocketEcho: z.literal(true),
});

const packageSchema = z.object({ name: z.literal('node-pty'), version: z.literal('1.1.0') });
const legalName = /^(?:licen[cs]e|copying|notice|copyright)(?:[.-].*)?$/iu;
const excludedDirectory = new Set(['test', 'tests', '__tests__', 'fixtures', 'benchmark']);

export function assertPtyNativeFiles(files: readonly string[]): void {
  const native = files.filter((name) => /\.(?:node|dll|exe|so|dylib)$/iu.test(name));
  if (native.length !== 1 || native[0] !== ptyNativeBinding)
    throw new Error('PTY release must contain exactly the Linux x64 build/Release/pty.node.');
}

export async function selectPtyPackageFiles(directory: string): Promise<string[]> {
  const selected: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name !== 'package.json' && !legalName.test(entry.name)) continue;
    if (!entry.isFile()) throw new Error(`PTY metadata must be a regular file: ${entry.name}`);
    selected.push(entry.name);
  }
  packageSchema.parse(
    JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as unknown,
  );
  async function walk(prefix: string): Promise<void> {
    const info = await lstat(join(directory, prefix));
    if (info.isSymbolicLink()) throw new Error(`PTY runtime contains a symlink: ${prefix}`);
    if (!info.isDirectory()) throw new Error(`PTY runtime directory is missing: ${prefix}`);
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`PTY runtime contains a symlink: ${name}`);
      if (entry.name.startsWith('.') || excludedDirectory.has(entry.name)) continue;
      if (entry.isDirectory()) await walk(name);
      else if (
        entry.isFile() &&
        /\.(?:js|json)$/u.test(entry.name) &&
        !/(?:^|[.-])(?:test|spec|bench)(?:[.-]|$)/iu.test(entry.name)
      )
        selected.push(name);
    }
  }
  await walk('lib');
  if (!selected.includes('lib/index.js')) throw new Error('PTY runtime is missing lib/index.js.');
  for (const prefix of ['build', 'build/Release']) {
    const info = await lstat(join(directory, prefix)).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink())
      throw new Error(`PTY native directory is missing or a symlink: ${prefix}`);
  }
  const bindingPath = join(directory, ptyNativeBinding);
  const info = await lstat(bindingPath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink())
    throw new Error(`Missing regular PTY native binding: ${ptyNativeBinding}`);
  const handle = await open(bindingPath, 'r');
  const header = Buffer.alloc(20);
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      header.readUInt16LE(16) !== 3 ||
      header.readUInt16LE(18) !== 62
    )
      throw new Error('PTY native binding must be a Linux x64 ELF shared library.');
  } finally {
    await handle.close();
  }
  selected.push(ptyNativeBinding);
  assertPtyNativeFiles(selected);
  return selected.sort();
}

export function isPtyRuntimeResource(path: string): boolean {
  return path.startsWith(`resources/runtime/${ptyPackagePath}/`);
}

interface RuntimeDependency {
  name: string;
  path: string;
  version: string;
  files: string[];
}

const runtimePackageSchema = z.looseObject({ dependencies: z.record(z.string(), z.string()) });

export function terminalPreviewMetadata(
  runtimePackage: unknown,
  release: { runtimeDependencyRoots: string[]; runtimeDependencies: RuntimeDependency[] },
) {
  const parsed = runtimePackageSchema.parse(runtimePackage);
  const dependencies = { ...parsed.dependencies };
  delete dependencies['node-pty'];
  return {
    runtimePackage: { ...parsed, dependencies },
    runtimeDependencyRoots: release.runtimeDependencyRoots.filter((name) => name !== 'node-pty'),
    runtimeDependencies: release.runtimeDependencies.filter((item) => item.name !== 'node-pty'),
    terminal: { supported: false, reason: 'platform-unsupported' } as const,
  };
}
