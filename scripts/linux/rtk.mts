/**
 * @file 准备固定版本的 Linux x64 RTK OSS 发布输入。
 * @implementation 从显式归档或固定 URL 填充按哈希寻址的本地缓存，在独立空目录解包并验证二进制与许可证，全程不执行 RTK。
 * @updated 2026-11-26T01:32:35+08:00
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { rtkLauncher, rtkRelease } from '../../shared/builtin-rtk.js';

const archiveName = 'rtk-oss-x86_64-unknown-linux-musl.tar.gz';

export function rtkArchiveCachePath(root: string): string {
  return join(root, '.local/cache/rtk', rtkRelease.archiveSha256, archiveName);
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  await pipeline(createReadStream(path), digest);
  return digest.digest('hex');
}

async function verifyFile(path: string, expected: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`RTK release input must be a regular file: ${path}`);
  if ((await sha256(path)) !== expected)
    throw new Error(`RTK ${rtkRelease.version} SHA-256 mismatch: ${path}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function tar(root: string, args: string[]): string {
  const result = spawnSync('tar', args, {
    cwd: root,
    env: { ...process.env, TAR_OPTIONS: '', GZIP: '' },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`RTK archive extraction failed: ${result.stdout}${result.stderr}`);
  return result.stdout;
}

export interface PreparedRtk {
  archive: string;
  binary: string;
  license: string;
}

/** work must be a disposable build directory; downloaded contents never become cwd. */
export async function prepareRtkRelease(
  root: string,
  work: string,
  explicitArchive?: string,
): Promise<PreparedRtk> {
  const archive = rtkArchiveCachePath(root);
  // Copy or download only into a new empty directory; extraction gets another one.
  const download = await mkdtemp(join(work, 'rtk-download-'));
  const incoming = join(download, archiveName);
  try {
    if (explicitArchive) {
      const source = resolve(explicitArchive);
      await verifyFile(source, rtkRelease.archiveSha256);
      await copyFile(source, incoming);
    } else if (await exists(archive)) {
      await verifyFile(archive, rtkRelease.archiveSha256);
      await copyFile(archive, incoming);
    } else {
      const response = await fetch(rtkRelease.source.archive, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok)
        throw new Error(`Pinned RTK archive download failed: HTTP ${response.status}`);
      // Bound the fixed small release asset before writing it to disk.
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (!response.body) throw new Error('Pinned RTK archive download has no body.');
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 16 * 1024 * 1024)
          throw new Error('Pinned RTK archive exceeds its release input size limit.');
        chunks.push(chunk);
      }
      await writeFile(incoming, Buffer.concat(chunks), { mode: 0o600 });
    }
    await verifyFile(incoming, rtkRelease.archiveSha256);
    await mkdir(dirname(archive), { recursive: true });
    // Promote only validated bytes. A failed download leaves any prior cache intact.
    await chmod(incoming, 0o644);
    await rename(incoming, archive);
  } finally {
    await rm(download, { recursive: true, force: true });
  }
  await verifyFile(archive, rtkRelease.archiveSha256);
  const entries = tar(root, ['-tzf', archive]).trim().split('\n').sort();
  if (entries.join('\n') !== 'LICENSE\nrtk')
    throw new Error('Pinned RTK archive must contain exactly rtk and LICENSE.');
  const extraction = await mkdtemp(join(work, 'rtk-extract-'));
  tar(root, [
    '--extract',
    '--gzip',
    '--file',
    archive,
    '--directory',
    extraction,
    '--no-same-owner',
    '--no-same-permissions',
    '--',
    'rtk',
    'LICENSE',
  ]);
  const binary = join(extraction, 'rtk');
  const license = join(extraction, 'LICENSE');
  await verifyFile(binary, rtkRelease.binarySha256);
  await verifyFile(license, rtkRelease.licenseSha256);
  if (!((await lstat(binary)).mode & 0o111))
    throw new Error('Pinned RTK binary is missing its executable bit.');
  const handle = await open(binary, 'r');
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      ![0, 3].includes(header[7] ?? -1) ||
      ![2, 3].includes(header.readUInt16LE(16)) ||
      header.readUInt16LE(18) !== 62
    )
      throw new Error('Pinned RTK must be a Linux x64 ELF executable.');
  } finally {
    await handle.close();
  }
  return { archive, binary, license };
}

/** Verify packaged bytes and modes directly, without executing or extracting a payload. */
export function verifyRtkArchive(
  root: string,
  archive: string,
  prefix: string,
  tool: 'tar' | 'bsdtar' = 'tar',
): void {
  for (const [path, expected, mode] of [
    [`resources/${rtkRelease.resourcePath}`, rtkRelease.binarySha256, '-rwxr-xr-x'],
    [
      `resources/${rtkRelease.launcherPath}`,
      createHash('sha256').update(rtkLauncher).digest('hex'),
      '-rwxr-xr-x',
    ],
    ['resources/licenses/rtk/LICENSE', rtkRelease.licenseSha256, '-rw-r--r--'],
  ] as const) {
    const name = `${prefix}/${path}`;
    const result = spawnSync(tool, ['-xOf', archive, name], {
      cwd: root,
      env: { ...process.env, TAR_OPTIONS: '', GZIP: '' },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    if (
      result.status !== 0 ||
      createHash('sha256').update(result.stdout).digest('hex') !== expected
    )
      throw new Error(`Packaged RTK resource SHA-256 mismatch: ${name}`);
    const listing = spawnSync(tool, ['-tvf', archive, name], {
      cwd: root,
      env: { ...process.env, TAR_OPTIONS: '', GZIP: '' },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    if (listing.error) throw listing.error;
    if (listing.status !== 0 || !listing.stdout.startsWith(`${mode} `))
      throw new Error(`Packaged RTK resource mode mismatch: ${name}`);
  }
}

/** Stage only the three allowlisted resources; inputs remain reproducible from the pin. */
export async function stageRtkRelease(
  root: string,
  work: string,
  stage: string,
  explicitArchive?: string,
) {
  const prepared = await prepareRtkRelease(root, work, explicitArchive);
  const licenseInput = join(root, 'docs/licenses', `rtk-oss-${rtkRelease.version}-LICENSE.txt`);
  await verifyFile(licenseInput, rtkRelease.licenseSha256);
  const binaryPath = `resources/${rtkRelease.resourcePath}`;
  const launcherPath = `resources/${rtkRelease.launcherPath}`;
  const licensePath = 'resources/licenses/rtk/LICENSE';
  const launcherSha256 = createHash('sha256').update(rtkLauncher).digest('hex');
  for (const [source, destination, mode] of [
    [prepared.binary, binaryPath, 0o755],
    [licenseInput, licensePath, 0o644],
  ] as const) {
    await mkdir(dirname(join(stage, destination)), { recursive: true });
    await copyFile(source, join(stage, destination));
    await chmod(join(stage, destination), mode);
  }
  await mkdir(dirname(join(stage, launcherPath)), { recursive: true });
  await writeFile(join(stage, launcherPath), rtkLauncher, { mode: 0o755 });
  await chmod(join(stage, launcherPath), 0o755);
  await verifyFile(join(stage, binaryPath), rtkRelease.binarySha256);
  await verifyFile(join(stage, licensePath), rtkRelease.licenseSha256);
  await verifyFile(join(stage, launcherPath), launcherSha256);
  return {
    inputs: { archive: prepared.archive, license: licenseInput },
    release: {
      ...rtkRelease,
      path: binaryPath,
      sha256: rtkRelease.binarySha256,
      launcher: { path: launcherPath, sha256: launcherSha256, mode: '755' },
      texts: [
        { path: licensePath, sha256: rtkRelease.licenseSha256, source: rtkRelease.source.archive },
      ],
    },
  };
}
