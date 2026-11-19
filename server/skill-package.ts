import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { fromBuffer } from 'yauzl';
import { AppError, type SkillPackage } from '../shared/types.js';

export const skillPackageLimits = {
  archive: 8 * 1024 * 1024,
  entries: 1000,
  file: 4 * 1024 * 1024,
  expanded: 16 * 1024 * 1024,
  markdown: 65_000,
} as const;

const unsupported = () =>
  new AppError(
    'SKILLHUB_PACKAGE_UNSUPPORTED',
    'SkillHub 包必须包含一份 SKILL.md，且只能包含路径安全的普通文件。',
    422,
  );
const tooLarge = () =>
  new AppError('SKILLHUB_TOO_LARGE', 'SkillHub 包的文件数量或展开大小超过读取上限。', 413);

function entryPath(value: string, directory: boolean): string {
  const path = directory ? value.slice(0, -1) : value;
  if (
    !path ||
    Buffer.byteLength(path, 'utf8') > 1024 ||
    /[\\:\u0000-\u001f\u007f]/.test(path) ||
    path !== path.normalize('NFC') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw unsupported();
  return path;
}

/** Read all package bytes in memory; never extract or execute downloaded files. */
export async function readSkillPackage(archive: Buffer): Promise<SkillPackage> {
  if (archive.length > skillPackageLimits.archive) throw tooLarge();
  try {
    const zip = await new Promise<import('yauzl').ZipFile>((resolve, reject) =>
      fromBuffer(
        archive,
        { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
        (error, zip) => (error ? reject(error) : resolve(zip!)),
      ),
    );
    try {
      if (zip.entryCount > skillPackageLimits.entries) throw tooLarge();
      const names = new Map<string, boolean>();
      const files: SkillPackage['files'] = [];
      let expanded = 0;
      let count = 0;
      for await (const entry of zip.eachEntry()) {
        if (++count > skillPackageLimits.entries) throw tooLarge();
        const directory = entry.fileName.endsWith('/');
        const path = entryPath(entry.fileName, directory);
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        const dosDirectory = (entry.externalFileAttributes & 0x10) !== 0;
        if (
          entry.isEncrypted() ||
          !entry.canDecodeFileData() ||
          (mode !== 0 && mode !== (directory ? 0o040000 : 0o100000)) ||
          (dosDirectory && !directory) ||
          (directory && entry.uncompressedSize !== 0)
        )
          throw unsupported();
        // Reject names that would alias on case-insensitive filesystems, as well as
        // files that collide with explicit or implicit parent directories.
        const key = path.toLowerCase();
        if (names.has(key)) throw unsupported();
        const parts = key.split('/');
        for (let i = 1; i < parts.length; i++) {
          if (names.get(parts.slice(0, i).join('/')) === false) throw unsupported();
        }
        if (!directory && [...names.keys()].some((name) => name.startsWith(key + '/')))
          throw unsupported();
        names.set(key, directory);
        if (directory) continue;
        const limit = /(?:^|\/)skill\.md$/i.test(path)
          ? skillPackageLimits.markdown
          : skillPackageLimits.file;
        if (
          entry.uncompressedSize > limit ||
          expanded + entry.uncompressedSize > skillPackageLimits.expanded
        )
          throw tooLarge();
        const stream = await zip.openReadStreamPromise(entry);
        const chunks: Buffer[] = [];
        let size = 0;
        let checksum = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > limit || expanded + size > skillPackageLimits.expanded) {
            stream.destroy();
            throw tooLarge();
          }
          checksum = crc32(bytes, checksum);
          chunks.push(bytes);
        }
        if (size !== entry.uncompressedSize || checksum !== entry.crc32) throw unsupported();
        expanded += size;
        files.push({ path, data: Buffer.concat(chunks, size).toString('base64') });
      }
      const manifests = files.filter((file) => /^(?:[^/]+\/)?skill\.md$/i.test(file.path));
      if (manifests.length !== 1) throw unsupported();
      const manifest = manifests[0]!;
      const root = manifest.path.slice(0, -'SKILL.md'.length);
      if (files.some((file) => !file.path.startsWith(root))) throw unsupported();
      for (const file of files) {
        file.path = file === manifest ? 'SKILL.md' : file.path.slice(root.length);
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { digest: createHash('sha256').update(archive).digest('hex'), files };
    } finally {
      zip.close();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unsupported();
  }
}
