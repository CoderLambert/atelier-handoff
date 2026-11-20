import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { inspectMarkdown, ProjectExtensions } from '../server/extensions.js';
import { fingerprint } from '../server/files.js';
import { previewPublic } from '../server/public-extensions.js';
import { readSkillPackage, skillPackageLimits } from '../server/skill-package.js';
import { Store } from '../server/store.js';

interface ZipEntry {
  path: string;
  body?: string | Buffer;
  mode?: number;
  attributes?: number;
  flags?: number;
  compressed?: boolean;
  reportedSize?: number;
  checksum?: number;
}

// Build small, deterministic ZIPs without invoking any downloaded tools or files.
function archive(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const path = Buffer.from(entry.path);
    const body = Buffer.from(entry.body ?? '');
    const encoded = entry.compressed ? deflateRawSync(body) : body;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0x800, 6);
    header.writeUInt16LE(entry.compressed ? 8 : 0, 8);
    header.writeUInt32LE(entry.checksum ?? crc32(body), 14);
    header.writeUInt32LE(encoded.length, 18);
    header.writeUInt32LE(entry.reportedSize ?? body.length, 22);
    header.writeUInt16LE(path.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4);
    header.copy(record, 6, 4, 30);
    record.writeUInt32LE(entry.attributes ?? ((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    local.push(header, path, encoded);
    central.push(record, path);
    offset += header.length + path.length + encoded.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const markdown =
  '---\nname: fixture\ndescription: Package fixture\n---\nRead [notes](references/notes.md).\n';
const manifest = { path: 'SKILL.md', body: markdown };
const notes = { path: 'references/notes.md', body: 'Support file contents' };
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const source = 'skillhub:@example/fixture@1.0.0';
function publicRequest(zip: Buffer): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/resolve'))
      return Response.json({
        namespace: { canonicalName: '@example/fixture', handle: 'example', publicSlug: 'fixture' },
        latestVersion: { version: '1.0.0' },
      });
    assert.equal(url.pathname, '/api/v1/download');
    return new Response(new Uint8Array(zip));
  };
}

test('ZIP package retains regular support files and binary bytes with a source archive digest', async () => {
  const binary = Buffer.from([0, 255, 128, 1]);
  const zip = archive([
    { path: 'fixture/', mode: 0o040755 },
    { ...manifest, path: 'fixture/skill.md' },
    { ...notes, path: 'fixture/' + notes.path },
    { path: 'fixture/assets/image.bin', body: binary },
    { path: 'fixture/scripts/check.sh', body: '#!/bin/sh\nexit 0\n', mode: 0o100755 },
  ]);
  const result = await readSkillPackage(zip);
  assert.equal(result.digest, digest(zip));
  assert.deepEqual(result.files.map((file) => file.path).sort(), [
    'SKILL.md',
    'assets/image.bin',
    'references/notes.md',
    'scripts/check.sh',
  ]);
  assert.deepEqual(
    Buffer.from(result.files.find((file) => file.path.endsWith('.bin'))!.data, 'base64'),
    binary,
  );
});

test('ZIP package rejects ambiguous, unsafe, non-regular and corrupted entries', async (t) => {
  const invalid: [string, ZipEntry[]][] = [
    ['missing manifest', [notes]],
    ['multiple manifests', [manifest, { path: 'nested/SKILL.md', body: 'Other' }]],
    ['outside wrapper', [{ ...manifest, path: 'wrapper/SKILL.md' }, notes]],
    ['parent traversal', [manifest, { path: '../outside' }]],
    ['absolute path', [manifest, { path: '/outside' }]],
    ['backslash', [manifest, { path: 'scripts\\outside' }]],
    ['drive path', [manifest, { path: 'C:/outside' }]],
    ['empty component', [manifest, { path: 'scripts//outside' }]],
    ['dot component', [manifest, { path: 'scripts/./outside' }]],
    ['null byte', [manifest, { path: 'scripts/a\0b' }]],
    ['duplicate', [manifest, notes, notes]],
    ['case collision', [manifest, notes, { ...notes, path: 'REFERENCES/notes.md' }]],
    ['noncanonical unicode', [manifest, { path: 'assets/e\u0301.txt' }]],
    ['parent file', [manifest, { path: 'references' }, notes]],
    ['child before parent file', [manifest, notes, { path: 'references' }]],
    ['directory masquerading as file', [manifest, { path: 'references', mode: 0o040755 }]],
    ['file masquerading as directory', [manifest, { path: 'references/', mode: 0o100644 }]],
    ['DOS directory masquerading as file', [manifest, { path: 'references', attributes: 0x10 }]],
    ['nonempty directory', [manifest, { path: 'references/', mode: 0o040755, body: 'bad' }]],
    ['symlink support file', [manifest, { ...notes, mode: 0o120777 }]],
    ['symlink directory', [manifest, { path: 'references/', mode: 0o120777 }]],
    ['FIFO', [manifest, { path: 'pipe', mode: 0o010644 }]],
    ['encrypted file', [manifest, { ...notes, flags: 0x801 }]],
    ['CRC mismatch', [manifest, { ...notes, checksum: 123 }]],
    ['actual expansion mismatch', [manifest, { ...notes, compressed: true, reportedSize: 1 }]],
  ];
  for (const [name, entries] of invalid) {
    await t.test(name, async () => {
      await assert.rejects(readSkillPackage(archive(entries)), {
        code: 'SKILLHUB_PACKAGE_UNSUPPORTED',
      });
    });
  }
  await assert.rejects(readSkillPackage(Buffer.from('not a ZIP')), {
    code: 'SKILLHUB_PACKAGE_UNSUPPORTED',
  });
});

test('ZIP package bounds archive bytes, entry count, manifest, individual files and total expansion', async () => {
  const compressed = { compressed: true };
  for (const entries of [
    [
      manifest,
      ...Array.from({ length: skillPackageLimits.entries }, (_, i) => ({ path: `file-${i}` })),
    ],
    [{ ...manifest, body: 'x'.repeat(skillPackageLimits.markdown + 1), ...compressed }],
    [
      manifest,
      { path: 'large.bin', body: Buffer.alloc(skillPackageLimits.file + 1), ...compressed },
    ],
    [
      manifest,
      ...Array.from({ length: 5 }, (_, i) => ({
        path: `file-${i}`,
        body: Buffer.alloc(skillPackageLimits.file),
        ...compressed,
      })),
    ],
  ]) {
    await assert.rejects(readSkillPackage(archive(entries)), { code: 'SKILLHUB_TOO_LARGE' });
  }
  await assert.rejects(readSkillPackage(Buffer.alloc(skillPackageLimits.archive + 1)), {
    code: 'SKILLHUB_TOO_LARGE',
  });
});

test('public preview omits support contents and opt-in import receives the normalized full package', async () => {
  const body = markdown.replace(
    'description: Package fixture',
    'description: Package fixture\nallowed-tools: [Read, Bash]',
  );
  const zip = archive([{ ...manifest, body }, notes]);
  const [preview] = await previewPublic(source, 'skill', publicRequest(zip));
  assert.equal(preview?.issue, undefined);
  assert.equal(preview?.package, undefined);
  assert.doesNotMatch(JSON.stringify(preview), /Support file contents|U3VwcG9ydCBmaWxl/);
  const [entry] = await previewPublic(source, 'skill', publicRequest(zip), {
    includePackage: true,
  });
  assert.equal(entry?.package?.digest, digest(zip));
  assert.equal(entry?.package?.files.length, 2);
  assert.equal(entry?.revision, fingerprint(entry!.body!));
  assert.doesNotMatch(entry!.body!, /allowed-tools/);
  assert.equal(
    Buffer.from(
      entry!.package!.files.find((file) => file.path === 'SKILL.md')!.data,
      'base64',
    ).toString(),
    entry!.body,
  );
  const invalidUtf8 = archive([{ path: 'SKILL.md', body: Buffer.from([0xff]) }]);
  await assert.rejects(previewPublic(source, 'skill', publicRequest(invalidUtf8)), {
    code: 'SKILLHUB_PACKAGE_UNSUPPORTED',
  });
});

test('package-aware inspection accepts existing support references without broadening execution permissions', async () => {
  const skillPackage = await readSkillPackage(archive([manifest, notes]));
  assert.equal(inspectMarkdown(markdown).supported, false);
  for (const body of [
    markdown,
    'Read [notes](./references/notes.md#section).',
    'Read [notes](references%2Fnotes.md).',
    'Read [notes](<references/notes.md>).',
    'Read `${CLAUDE_SKILL_DIR}/references/notes.md`.',
    'Read [notes](${CLAUDE_SKILL_DIR}/references/notes.md).',
    'Read [website](https://example.com/help).',
  ])
    assert.equal(inspectMarkdown(body, skillPackage).supported, true, body);
  for (const body of [
    'Read [missing](references/missing.md).',
    'Read [outside](../notes.md).',
    'Read [outside](/etc/passwd).',
    'Read [outside](file:///etc/passwd).',
    'Read `${CLAUDE_SKILL_DIR}/../outside`.',
    'Read `${CLAUDE_SKILL_DIR}/missing.md`.',
    'Prepare !`./scripts/generate`',
    'prefix!`./scripts/generate`',
    ...[
      'hooks: {}',
      'mcpServers: {}',
      'context: fork',
      'agent: custom',
      'allowed-tools: [Bash]',
      'permissions: {}',
      'permissionMode: bypassPermissions',
      'trust: true',
    ].map((key) => `---\n${key}\n---\nRead the notes.`),
  ])
    assert.equal(inspectMarkdown(body, skillPackage).supported, false, body);
});

test('registry persists packages, preserves them during edits and syncs support-only changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-package-store-'));
  let store = new Store(directory);
  try {
    store.put('projects', {
      id: 'project',
      name: 'Fixture',
      path: '/fixture',
      branch: 'main',
      available: true,
      createdAt: new Date().toISOString(),
    });
    const [entry] = await previewPublic(
      source,
      'skill',
      publicRequest(archive([manifest, notes])),
      { includePackage: true },
    );
    let registry = new ProjectExtensions(store);
    let item = registry.savePublic('project', entry!).item;
    assert.equal(item.kind, 'skill');
    if (item.kind !== 'skill') throw new Error('Expected skill');
    assert.equal(item.supported, true);
    assert.equal(item.enabled, true);
    assert.equal(item.autoInvoke, false);
    assert.deepEqual(item.package, entry!.package);
    store.close();
    store = new Store(directory);
    registry = new ProjectExtensions(store);
    item = registry.get('project', item.id);
    const renamed = registry.save(
      'project',
      {
        version: item.version,
        name: 'renamed',
        enabled: false,
        package: { digest: 'untrusted', files: [] },
      },
      item.id,
    );
    assert.equal(renamed.kind, 'skill');
    if (renamed.kind !== 'skill') throw new Error('Expected skill');
    assert.deepEqual(renamed.package, entry!.package);
    const changedPackage = {
      ...entry!,
      package: await readSkillPackage(archive([manifest, { ...notes, body: 'Revised support' }])),
    };
    const synced = registry.savePublic('project', changedPackage, renamed);
    assert.equal(synced.changed, true);
    assert.equal(synced.item.version, renamed.version + 1);
    assert.equal(synced.item.enabled, false);
    assert.equal(registry.savePublic('project', changedPackage, synced.item).changed, false);
    const edited = registry.save(
      'project',
      { version: synced.item.version, body: 'Local instructions' },
      synced.item.id,
    );
    if (edited.kind !== 'skill') throw new Error('Expected skill');
    assert.equal(
      Buffer.from(
        edited.package!.files.find((file) => file.path === 'SKILL.md')!.data,
        'base64',
      ).toString(),
      edited.body,
    );
    assert.throws(() => registry.savePublic('project', entry!, edited), {
      code: 'PUBLIC_LOCAL_MODIFIED',
    });
    const plain = registry.save('project', {
      kind: 'skill',
      name: 'plain',
      body: 'Local',
      package: entry!.package,
    });
    if (plain.kind !== 'skill') throw new Error('Expected skill');
    assert.equal(plain.package, undefined);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
