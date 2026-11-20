/**
 * @file 验证隔离文档解析、完整文本文件与失败清理。
 * @implementation 使用临时 Office/PDF 夹具覆盖工作表索引、段落、扫描和加密错误、ZIP 预算、取消，以及无 tsx 的编译 worker。
 * @updated 2026-11-21T15:30:00+08:00
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { build } from 'esbuild';
import XLSX from 'xlsx';
import { fromBufferPromise } from 'yauzl';
import {
  documentParserLimits,
  prepareDocumentView,
  validateDocumentFile,
} from '../server/attachment-document-reader.js';

const mime = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

interface ZipEntry {
  name: string;
  data: string | Buffer;
  compressed?: boolean;
  reportedSize?: number;
  checksum?: number;
  flags?: number;
  mode?: number;
}

function zip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const encoded = entry.compressed ? deflateRawSync(data) : data;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0x800, 6);
    header.writeUInt16LE(entry.compressed ? 8 : 0, 8);
    header.writeUInt32LE(entry.checksum ?? crc32(data), 14);
    header.writeUInt32LE(encoded.length, 18);
    header.writeUInt32LE(entry.reportedSize ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x0314, 4);
    header.copy(record, 6, 4, 30);
    record.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    local.push(header, name, encoded);
    central.push(record, name);
    offset += header.length + name.length + encoded.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function wordEntries(body = '<w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>'): ZipEntry[] {
  return [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ];
}

function workbook(bookType: XLSX.BookType = 'xlsx'): Buffer {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['title', 'amount'],
    ['first', 12.5],
  ]);
  sheet.A245 = { t: 's', v: 'late-row-245' };
  sheet.D245 = { t: 'b', v: false };
  sheet.E245 = { t: 'n', v: 25, f: 'B2*2' };
  sheet['!ref'] = 'A1:E245';
  XLSX.utils.book_append_sheet(book, sheet, '收入');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['second-sheet-marker']]), 'Second');
  return XLSX.write(book, { type: 'buffer', bookType, compression: false });
}

function pdf(pages: (string | null)[], encrypted = false): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids: string[] = [];
  for (const value of pages) {
    const number = objects.length + 1;
    kids.push(`${number} 0 R`);
    const content = value === null ? '0 0 10 10 re f' : `BT /F1 12 Tf 20 80 Td (${value}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${number + 1} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  if (encrypted)
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`,
    );
  let result = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

async function fixture(t: TestContext, data: Buffer | string) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-document-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'original');
  const directory = join(root, 'private output');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path, data);
  return { root, path, directory };
}

const code = (expected: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === expected;

for (const [format, type] of [
  ['xlsx', 'xlsx'],
  ['xls', 'biff8'],
  ['xls', 'biff2'],
] as const) {
  test(`${type} retains cells and original row indices beyond preview rows`, async (t) => {
    const input = await fixture(t, workbook(type));
    await validateDocumentFile(input.path, mime[format]);
    const view = await prepareDocumentView({ ...input, mime: mime[format] });
    assert.ok(view.preview.length <= documentParserLimits.previewCharacters);
    assert.match(view.preview, /Preview only/);
    const file = view.files[0];
    assert.ok(file);
    const text = await readFile(file.path, 'utf8');
    assert.match(text, /Row 245\nA245: .*late-row-245/);
    assert.match(text, /D245: .*"value":false/);
    assert.match(text, /E245: .*"value":25/);
    if (type !== 'biff2') {
      if (type === 'xlsx') assert.match(text, /"formula":"B2\*2"/);
      assert.equal(view.files.length, 2);
      const second = view.files[1];
      assert.ok(second);
      assert.match(await readFile(second.path, 'utf8'), /second-sheet-marker/);
      assert.match(text, /收入/);
    }
    assert.equal((await stat(file.path)).mode & 0o777, 0o600);
    assert.ok((await readFile(input.path)).equals(workbook(type)));
  });
}

test('valid worksheet larger than 20 MiB produces a complete range-readable view', async (t) => {
  const book = XLSX.utils.book_new();
  const rows = Array.from({ length: 700 }, (_, i) => [
    `${i}-${'x'.repeat(32_000)}`,
    `row-${i + 1}`,
  ]);
  rows[699] = ['last-large-worksheet-row', 'large-final-marker'];
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Large');
  const data = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: false });
  assert.ok(data.length > 20 * 1024 * 1024);
  const input = await fixture(t, data);
  const view = await prepareDocumentView({ ...input, mime: mime.xlsx });
  const file = view.files[0];
  assert.ok(file);
  const text = await readFile(file.path, 'utf8');
  assert.match(text, /Row 700\nA700: .*last-large-worksheet-row/);
  assert.match(text, /B700: .*large-final-marker/);
  assert.ok(!view.preview.includes('large-final-marker'));
  assert.ok(text.split('\n').every((line) => line.length <= documentParserLimits.lineCharacters));
});

test('sparse worksheet retains a cell outside a misleading dimension without walking blank cells', async (t) => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['first']]), 'Sparse');
  const archive = await fromBufferPromise(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), {
    lazyEntries: true,
    autoClose: false,
  });
  const entries: ZipEntry[] = [];
  try {
    for await (const entry of archive.eachEntry()) {
      const stream = await archive.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      let data = Buffer.concat(chunks);
      if (entry.fileName === 'xl/worksheets/sheet1.xml')
        data = Buffer.from(
          data
            .toString('utf8')
            .replace(
              '</sheetData>',
              '<row r="1048576"><c r="XFD1048576" t="str"><v>far-away</v></c></row></sheetData>',
            ),
        );
      entries.push({ name: entry.fileName, data });
    }
  } finally {
    archive.close();
  }
  const input = await fixture(t, zip(entries));
  const view = await prepareDocumentView({ ...input, mime: mime.xlsx });
  const file = view.files[0];
  assert.ok(file);
  const text = await readFile(file.path, 'utf8');
  assert.match(text, /Row 1048576\nXFD1048576: .*far-away/);
  assert.ok(text.length < 1000);
});

test('Mammoth raw text retains paragraph gaps, tabs, XML entities and Unicode', async (t) => {
  const body =
    '<w:p><w:r><w:t>First &amp; 中文</w:t><w:tab/><w:t>tabbed</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>Third paragraph 😀</w:t></w:r></w:p>';
  const input = await fixture(t, zip(wordEntries(body)));
  const view = await prepareDocumentView({ ...input, mime: mime.docx });
  const file = view.files[0];
  assert.ok(file);
  assert.match(await readFile(file.path, 'utf8'), /First & 中文\ttabbed\n\n\n\nThird paragraph 😀/);
});

test('PDF text is extracted locally with page numbers and image-only page markers', async (t) => {
  const input = await fixture(t, pdf(['first page marker', null, 'last page marker']));
  await validateDocumentFile(input.path, mime.pdf);
  const view = await prepareDocumentView({ ...input, mime: mime.pdf });
  const file = view.files[0];
  assert.ok(file);
  const text = await readFile(file.path, 'utf8');
  assert.match(text, /\[Page 1\]\nfirst page marker/);
  assert.match(text, /\[Page 2\]\n\[No extractable text/);
  assert.match(text, /\[Page 3\]\nlast page marker/);
});

test('image-only PDF fails with an explicit OCR error and removes partial output', async (t) => {
  const input = await fixture(t, pdf([null]));
  await assert.rejects(
    prepareDocumentView({ ...input, mime: mime.pdf }),
    (error: unknown) =>
      code('DOCUMENT_NO_TEXT')(error) && error instanceof Error && /OCR/.test(error.message),
  );
  assert.deepEqual(await readdir(input.directory), []);
});

test('password-protected PDF returns a specific error', async (t) => {
  const input = await fixture(t, pdf(['secret'], true));
  await assert.rejects(
    prepareDocumentView({ ...input, mime: mime.pdf }),
    code('DOCUMENT_PASSWORD_REQUIRED'),
  );
  assert.deepEqual(await readdir(input.directory), []);
});

test('Office validation rejects missing named entries and mismatched formats', async (t) => {
  const input = await fixture(t, zip([{ name: 'word/document.xml', data: '<document/>' }]));
  await assert.rejects(validateDocumentFile(input.path, mime.docx), code('DOCUMENT_INVALID'));
  await writeFile(input.path, zip(wordEntries()));
  await assert.rejects(validateDocumentFile(input.path, mime.xlsx), code('DOCUMENT_INVALID'));
  await writeFile(input.path, 'a,b\n1,2');
  await assert.rejects(validateDocumentFile(input.path, mime.xls), code('DOCUMENT_INVALID'));
  await assert.rejects(validateDocumentFile(input.path, mime.pdf), code('DOCUMENT_INVALID'));
});

for (const [label, extra] of [
  ['unsafe path', { name: '../evil.xml', data: '<x/>' }],
  ['duplicate name', { name: 'WORD/DOCUMENT.XML', data: '<x/>' }],
  ['symlink', { name: 'word/link', data: 'target', mode: 0o120777 }],
] as const) {
  test(`Office ZIP rejects ${label}`, async (t) => {
    const input = await fixture(t, zip([...wordEntries(), extra]));
    await assert.rejects(validateDocumentFile(input.path, mime.docx), code('DOCUMENT_INVALID'));
  });
}

test('Office ZIP rejects encrypted entries and modern Office OLE encryption', async (t) => {
  const input = await fixture(
    t,
    zip([...wordEntries(), { name: 'word/secret.xml', data: 'x', flags: 0x801, compressed: true }]),
  );
  await assert.rejects(
    validateDocumentFile(input.path, mime.docx),
    code('DOCUMENT_PASSWORD_REQUIRED'),
  );
  await writeFile(input.path, Buffer.from('d0cf11e0a1b11ae10000000000000000', 'hex'));
  await assert.rejects(
    validateDocumentFile(input.path, mime.docx),
    code('DOCUMENT_PASSWORD_REQUIRED'),
  );
});

test('Office expansion budget rejects highly compressed payloads before parsing', async (t) => {
  const input = await fixture(
    t,
    zip([
      ...wordEntries(),
      { name: 'word/bomb.xml', data: 'a'.repeat(4 * 1024 * 1024), compressed: true },
    ]),
  );
  await assert.rejects(
    validateDocumentFile(input.path, mime.docx),
    code('DOCUMENT_RESOURCE_LIMIT'),
  );
  await assert.rejects(
    prepareDocumentView({ ...input, mime: mime.docx }),
    code('DOCUMENT_RESOURCE_LIMIT'),
  );
  assert.deepEqual(await readdir(input.directory), []);
});

for (const [label, extra] of [
  ['CRC mismatch', { name: 'word/extra.xml', data: '<x/>', compressed: true, checksum: 0 }],
  [
    'forged expanded size',
    { name: 'word/extra.xml', data: '<x/>', compressed: true, reportedSize: 1 },
  ],
] as const) {
  test(`Office full processing rejects ${label}, while lightweight validation does not inflate`, async (t) => {
    const input = await fixture(t, zip([...wordEntries(), extra]));
    await validateDocumentFile(input.path, mime.docx);
    await assert.rejects(
      prepareDocumentView({ ...input, mime: mime.docx }),
      code('DOCUMENT_INVALID'),
    );
    assert.deepEqual(await readdir(input.directory), []);
  });
}

test('cancellation rejects before starting and stops an active worker without leftover output', async (t) => {
  const input = await fixture(t, zip(wordEntries()));
  const before = new AbortController();
  before.abort();
  await assert.rejects(prepareDocumentView({ ...input, mime: mime.docx, signal: before.signal }), {
    name: 'AbortError',
  });
  const active = new AbortController();
  const preparing = prepareDocumentView({ ...input, mime: mime.docx, signal: active.signal });
  // The async directory and worker setup yields before the first worker can finish parsing.
  setTimeout(() => active.abort(), 20);
  await assert.rejects(preparing, { name: 'AbortError' });
  assert.deepEqual(await readdir(input.directory), []);
});

test('output directory must exist and be private; source symlinks and unsupported MIME fail', async (t) => {
  const input = await fixture(t, zip(wordEntries()));
  await assert.rejects(
    prepareDocumentView({ ...input, directory: join(input.root, 'missing'), mime: mime.docx }),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    prepareDocumentView({ ...input, mime: 'text/html' }),
    code('DOCUMENT_UNSUPPORTED'),
  );
  await symlink(input.path, join(input.root, 'alias'));
  await assert.rejects(
    validateDocumentFile(join(input.root, 'alias'), mime.docx),
    code('DOCUMENT_INVALID'),
  );
  if (process.platform !== 'win32') {
    await chmod(input.directory, 0o755);
    await assert.rejects(
      prepareDocumentView({ ...input, mime: mime.docx }),
      code('DOCUMENT_DIRECTORY_INVALID'),
    );
  }
});

test('compiled .js worker works from a package closure with no tsx or optional canvas', async (t) => {
  const input = await fixture(t, zip(wordEntries()));
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const runtime = join(input.root, 'installed runtime');
  await build({
    absWorkingDir: project,
    entryPoints: [
      'server/attachment-document-reader.ts',
      'server/attachment-document-worker.ts',
      'server/attachment-document-protocol.ts',
      'shared/types.ts',
    ],
    outdir: runtime,
    outbase: project,
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  });
  await writeFile(join(runtime, 'package.json'), '{"type":"module"}');
  const copied = new Set<string>();
  async function copyClosure(name: string, from = project): Promise<void> {
    let source = '';
    for (let directory = from; ; directory = dirname(directory)) {
      const candidate = join(directory, 'node_modules', name);
      try {
        await stat(join(candidate, 'package.json'));
        source = candidate;
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        if (directory === dirname(directory)) throw new Error(`Missing dependency: ${name}`);
      }
    }
    if (copied.has(source)) return;
    copied.add(source);
    const { cp } = await import('node:fs/promises');
    const destination = join(runtime, relative(project, source));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, {
      recursive: true,
      filter: (path) => relative(source, path).split(sepForTest)[0] !== 'node_modules',
    });
    const manifest: unknown = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    if (
      manifest &&
      typeof manifest === 'object' &&
      'dependencies' in manifest &&
      manifest.dependencies &&
      typeof manifest.dependencies === 'object'
    )
      for (const dependency of Object.keys(manifest.dependencies))
        await copyClosure(dependency, source);
  }
  const sepForTest = process.platform === 'win32' ? '\\' : '/';
  for (const name of ['mammoth', 'xlsx', 'pdfjs-dist', 'yauzl', 'zod']) await copyClosure(name);
  await assert.rejects(stat(join(runtime, 'node_modules/tsx')), { code: 'ENOENT' });
  await assert.rejects(stat(join(runtime, 'node_modules/@napi-rs/canvas')), { code: 'ENOENT' });
  const xlsxPath = join(input.root, 'worksheet');
  const pdfPath = join(input.root, 'pdf');
  await writeFile(xlsxPath, workbook());
  await writeFile(pdfPath, pdf(['installed pdf marker']));
  const script = `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareDocumentView } from './server/attachment-document-reader.js';
for (const input of ${JSON.stringify([
    { path: input.path, directory: input.directory, mime: mime.docx, marker: 'First paragraph' },
    { path: xlsxPath, directory: input.directory, mime: mime.xlsx, marker: 'late-row-245' },
    { path: pdfPath, directory: input.directory, mime: mime.pdf, marker: 'installed pdf marker' },
  ])}) {
const view = await prepareDocumentView(input);
assert.ok(view.files.length);
assert.ok((await readFile(view.files[0].path, 'utf8')).includes(input.marker));
}
console.log('compiled-document-parser-ok');`;
  await writeFile(join(runtime, 'smoke.mjs'), script);
  const child = spawn(process.execPath, [join(runtime, 'smoke.mjs')], {
    cwd: input.root,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk;
  });
  const [status] = await once(child, 'close');
  assert.equal(status, 0, stderr);
  assert.match(stdout, /compiled-document-parser-ok/);
});

test('worker supervisor handles invalid messages, crashes, time and heap exhaustion', async (t) => {
  const input = await fixture(t, zip(wordEntries()));
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const runtime = join(input.root, 'supervision');
  await build({
    absWorkingDir: project,
    entryPoints: [
      'server/attachment-document-reader.ts',
      'server/attachment-document-protocol.ts',
      'shared/types.ts',
    ],
    outdir: runtime,
    outbase: project,
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    plugins: [
      {
        name: 'small-test-budgets',
        setup(builder) {
          builder.onLoad({ filter: /attachment-document-protocol\.ts$/ }, async ({ path }) => ({
            // Exercise the same supervisor with cheap test budgets rather than a 60-second hang.
            contents: (await readFile(path, 'utf8'))
              .replace('timeoutMs: 60_000', 'timeoutMs: 1000')
              .replace('oldGenerationMb: 512', 'oldGenerationMb: 16'),
            loader: 'ts',
          }));
        },
      },
    ],
  });
  await writeFile(join(runtime, 'package.json'), '{"type":"module"}');
  await symlink(join(project, 'node_modules'), join(runtime, 'node_modules'), 'junction');
  const imported: unknown = await import(
    pathToFileURL(join(runtime, 'server/attachment-document-reader.js')).href
  );
  assert.ok(
    imported &&
      typeof imported === 'object' &&
      'prepareDocumentView' in imported &&
      typeof imported.prepareDocumentView === 'function',
  );
  // The compiled file is produced from the same typed public entry above.
  const prepare = imported.prepareDocumentView as typeof prepareDocumentView;
  const worker = join(runtime, 'server/attachment-document-worker.js');
  for (const scenario of [
    {
      name: 'invalid reply',
      script:
        'import { parentPort } from "node:worker_threads"; parentPort.postMessage({wrong:true});',
      error: 'DOCUMENT_WORKER_FAILED',
    },
    {
      name: 'crash',
      script: 'throw new Error("parser failure");',
      error: 'DOCUMENT_WORKER_FAILED',
    },
    { name: 'early exit', script: 'process.exit(0);', error: 'DOCUMENT_WORKER_FAILED' },
    {
      name: 'time budget',
      script:
        'import { workerData } from "node:worker_threads"; import { writeFileSync } from "node:fs"; import { join } from "node:path"; writeFileSync(join(workerData.directory,"partial.txt"),"partial"); while(true){}',
      error: 'DOCUMENT_TIMEOUT',
    },
    {
      name: 'heap budget',
      script: 'const retained=[]; while(true) retained.push(new Array(10000).fill("cell"));',
      error: 'DOCUMENT_RESOURCE_LIMIT',
    },
  ]) {
    await t.test(scenario.name, async () => {
      await writeFile(worker, scenario.script);
      await assert.rejects(prepare({ ...input, mime: mime.docx }), code(scenario.error));
      assert.deepEqual(await readdir(input.directory), []);
    });
  }
});
