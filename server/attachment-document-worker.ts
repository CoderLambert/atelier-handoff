/**
 * @file 在隔离 worker 中校验并提取附件文档。
 * @implementation 顺序验证 Office ZIP 的结构、展开字节和 CRC，使用 SheetJS、Mammoth、PDF.js 输出带索引的 UTF-8 文本，限制解析资源。
 * @updated 2026-11-21T15:30:00+08:00
 */
import { open, lstat, readFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { crc32 } from 'node:zlib';
import { openPromise } from 'yauzl';
import {
  documentJobSchema,
  documentParserLimits as limits,
  type DocumentFailureCode,
  type DocumentJob,
  type DocumentReply,
} from './attachment-document-protocol.js';

class DocumentFailure extends Error {
  constructor(
    readonly code: DocumentFailureCode,
    message: string,
  ) {
    super(message);
  }
}
const invalid = (message = 'Document is malformed or does not match its declared format.') =>
  new DocumentFailure('DOCUMENT_INVALID', message);
const budget = (message: string) => new DocumentFailure('DOCUMENT_RESOURCE_LIMIT', message);
const password = () =>
  new DocumentFailure(
    'DOCUMENT_PASSWORD_REQUIRED',
    'This document is password protected. Supply an unlocked copy.',
  );

const cfb = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const modernExcel = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const word = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function validateSignature(job: DocumentJob): Promise<void> {
  const info = await lstat(job.path);
  if (!info.isFile() || !info.size) throw invalid('Document must be a nonempty regular file.');
  const handle = await open(job.path, 'r');
  const header = Buffer.alloc(1024);
  let length: number;
  try {
    length = (await handle.read(header, 0, header.length, 0)).bytesRead;
  } finally {
    await handle.close();
  }
  const bytes = header.subarray(0, length);
  if (job.mime === 'application/pdf') {
    if (!/%PDF-[12]\.\d/.test(bytes.toString('latin1'))) throw invalid('PDF signature is missing.');
  } else if (job.mime === 'application/vnd.ms-excel') {
    // BIFF2/3/4 are standalone streams, unlike BIFF5/8's OLE compound files.
    const bof = length >= 8 ? bytes.readUInt16LE(0) : -1;
    if (!bytes.subarray(0, 8).equals(cfb) && ![0x0009, 0x0209, 0x0409, 0x0809].includes(bof))
      throw invalid('XLS signature is missing (OLE or legacy BIFF required).');
  } else {
    if (bytes.subarray(0, 8).equals(cfb)) throw password();
    if (length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
      throw invalid('Office ZIP signature is missing.');
    await validateOffice(job.path, job.mime, job.operation === 'prepare');
  }
  if (job.operation === 'prepare' && info.size > limits.sourceBytes)
    throw budget(
      'Document exceeds the parser’s 256 MiB source working-memory budget. The original remains available.',
    );
}

async function validateOffice(path: string, mime: string, inflate: boolean): Promise<void> {
  const zip = await openPromise(path, {
    lazyEntries: true,
    autoClose: false,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    if (zip.entryCount > limits.zipEntries)
      throw budget('Office ZIP exceeds the 20,000 entry parsing budget.');
    const names = new Set<string>();
    const normalizedNames = new Set<string>();
    let declaredBytes = 0;
    let expandedBytes = 0;
    let count = 0;
    for await (const entry of zip.eachEntry()) {
      if (++count > limits.zipEntries)
        throw budget('Office ZIP exceeds the 20,000 entry parsing budget.');
      const name = entry.fileName;
      const directory = name.endsWith('/');
      const clean = directory ? name.slice(0, -1) : name;
      if (
        !clean ||
        Buffer.byteLength(name) > 2048 ||
        /[\\:\u0000-\u001f\u007f]/.test(name) ||
        clean.split('/').some((part) => !part || part === '.' || part === '..') ||
        normalizedNames.has(clean.normalize('NFC').toLowerCase())
      )
        throw invalid('Office ZIP contains an unsafe or duplicate entry name.');
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (entry.isEncrypted()) throw password();
      if (!entry.canDecodeFileData() || (mode && mode !== (directory ? 0o040000 : 0o100000)))
        throw invalid('Office ZIP contains an unsupported entry.');
      if (directory && entry.uncompressedSize !== 0)
        throw invalid('Office ZIP directory contains data.');
      normalizedNames.add(clean.normalize('NFC').toLowerCase());
      names.add(name);
      declaredBytes += entry.uncompressedSize;
      if (
        entry.uncompressedSize > limits.zipEntryBytes ||
        declaredBytes > limits.zipExpandedBytes ||
        entry.uncompressedSize >
          Math.max(64 * 1024, entry.compressedSize * limits.zipExpansionRatio)
      )
        throw budget(
          'Office ZIP exceeds the expansion budget (128 MiB per entry, 256 MiB total, or 1000:1 compression).',
        );
      if (!inflate || directory) continue;
      const stream = await zip.openReadStreamPromise(entry);
      let size = 0;
      let checksum = 0;
      try {
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          expandedBytes += bytes.length;
          if (size > limits.zipEntryBytes || expandedBytes > limits.zipExpandedBytes)
            throw budget('Office ZIP actual expansion exceeds the parsing budget.');
          checksum = crc32(bytes, checksum);
        }
      } finally {
        stream.destroy();
      }
      if (size !== entry.uncompressedSize || checksum !== entry.crc32)
        throw invalid('Office ZIP entry size or checksum is invalid.');
    }
    const required =
      mime === word
        ? ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']
        : ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels'];
    if (
      required.some((name) => !names.has(name)) ||
      (mime === modernExcel &&
        ![...names].some((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name)))
    )
      throw invalid('Office ZIP is missing the required Word document or Excel workbook entries.');
  } finally {
    zip.close();
  }
}

// Preserve Unicode boundaries while keeping each line short enough for native Read.
function prefix(text: string, length: number): string {
  let end = Math.min(text.length, length);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

class TextOutput {
  private bytes = 0;
  private preview = '';
  readonly files: { name: string; description: string }[] = [];
  constructor(private readonly directory: string) {}

  async file(
    name: string,
    description: string,
    write: (text: (value: string) => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const file = await open(join(this.directory, name), 'wx', 0o600);
    let pending = '';
    const flush = async () => {
      if (pending) {
        await file.writeFile(pending, 'utf8');
        pending = '';
      }
    };
    const line = async (value: string) => {
      const text = value + '\n';
      this.bytes += Buffer.byteLength(text);
      if (this.bytes > limits.outputBytes)
        throw budget('Extracted text exceeds the 128 MiB output budget.');
      if (this.preview.length < limits.previewCharacters)
        this.preview += prefix(text, limits.previewCharacters - this.preview.length);
      pending += text;
      if (pending.length >= 64 * 1024) await flush();
    };
    const text = async (value: string) => {
      let start = 0;
      do {
        const newline = value.indexOf('\n', start);
        const end = newline < 0 ? value.length : newline;
        let segment = value.slice(start, end).replace(/\r$/, '');
        while (segment.length > limits.lineCharacters) {
          const piece = prefix(segment, limits.lineCharacters);
          await line(piece);
          segment = segment.slice(piece.length);
        }
        await line(segment);
        if (newline < 0 || newline === value.length - 1) break;
        start = newline + 1;
      } while (start <= value.length);
    };
    try {
      await write(text);
      await flush();
      this.files.push({ name, description });
    } finally {
      await file.close();
    }
  }

  result(): DocumentReply {
    const suffix =
      '\n[Preview only. Read the generated text files by line range for the full document.]';
    return {
      ok: true,
      files: this.files,
      preview: prefix(this.preview, limits.previewCharacters - suffix.length) + suffix,
    };
  }
}

async function spreadsheet(job: DocumentJob, output: TextOutput): Promise<void> {
  const { default: XLSX } = await import('xlsx');
  const workbook = XLSX.read(await readFile(job.path), {
    type: 'buffer',
    sheetRows: 0,
    nodim: true,
    cellFormula: true,
    cellText: true,
    cellHTML: false,
    bookVBA: false,
    WTF: true,
  });
  if (!workbook.SheetNames.length) throw invalid('Workbook contains no worksheets.');
  if (workbook.SheetNames.length > limits.worksheets)
    throw budget('Workbook exceeds the 1,000 worksheet parsing budget.');
  let cells = 0;
  for (const [index, name] of workbook.SheetNames.entries()) {
    const sheet = workbook.Sheets[name];
    if (!sheet) throw invalid('Workbook worksheet is missing.');
    const addresses = Object.keys(sheet).filter((address) => /^[A-Z]+[1-9]\d*$/.test(address));
    cells += addresses.length;
    if (cells > limits.cells)
      throw budget('Workbook exceeds the 2,000,000 populated-cell parsing budget.');
    // Iterate populated cells, never the potentially enormous declared rectangular range.
    const entries = addresses.map((address) => ({
      address,
      position: XLSX.utils.decode_cell(address),
    }));
    entries.sort((a, b) => a.position.r - b.position.r || a.position.c - b.position.c);
    const hidden = workbook.Workbook?.Sheets?.[index]?.Hidden;
    await output.file(
      `sheet-${String(index + 1).padStart(4, '0')}.txt`,
      `Worksheet ${index + 1}: ${name.slice(0, 1000)}; ${entries.length} populated cells. Original row numbers and cell addresses; JSON-encoded raw values, display text, and formulas.`,
      async (text) => {
        await text(`Worksheet ${index + 1}: ${JSON.stringify(name)}${hidden ? ' (hidden)' : ''}`);
        await text(
          'Original row numbers and cell addresses. Cell records use JSON values; long records wrap at 1600 characters. Formulas are stored, never executed.',
        );
        let row = -1;
        for (const entry of entries) {
          const cell: import('xlsx').CellObject | undefined = sheet[entry.address];
          if (!cell) continue;
          if (entry.position.r !== row) {
            row = entry.position.r;
            await text(`Row ${row + 1}`);
          }
          await text(
            `${entry.address}: ${JSON.stringify({ type: cell.t, value: cell.v ?? null, ...(cell.w === undefined ? {} : { display: cell.w }), ...(cell.f === undefined ? {} : { formula: cell.f }) })}`,
          );
        }
        if (!entries.length) await text('[Empty worksheet]');
      },
    );
  }
}

async function docx(job: DocumentJob, output: TextOutput): Promise<void> {
  const { default: mammoth } = await import('mammoth');
  // extractRawText does not render HTML, load links, or read external images.
  const result = await mammoth.extractRawText({ path: job.path });
  if (!result.value.trim())
    throw new DocumentFailure('DOCUMENT_NO_TEXT', 'Word document contains no extractable text.');
  await output.file(
    'document.txt',
    'Word document plain text. Paragraph boundaries are preserved; long lines are wrapped for range reads.',
    async (text) => {
      await text('Word document — extracted raw text (paragraphs separated by blank lines)');
      await text(result.value);
    },
  );
}

async function pdf(job: DocumentJob, output: TextOutput): Promise<void> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const assets = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
  // Both the parser and PDF.js's own fake worker stay local to this bounded worker.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    '../build/pdf.worker.mjs',
    import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'),
  ).href;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(job.path)),
    cMapUrl: join(assets, 'cmaps') + sep,
    cMapPacked: true,
    standardFontDataUrl: join(assets, 'standard_fonts') + sep,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    if (document.numPages > limits.pdfPages)
      throw budget('PDF exceeds the 10,000 page parsing budget.');
    let hasText = false;
    await output.file(
      'document.txt',
      `PDF text with original page numbers (${document.numPages} pages). Image-only pages require OCR; no OCR is performed.`,
      async (text) => {
        await text(`PDF extracted text — ${document.numPages} pages`);
        for (let number = 1; number <= document.numPages; number++) {
          await text(`\n[Page ${number}]`);
          const page = await document.getPage(number);
          let pageHasText = false;
          const reader = page.streamTextContent().getReader();
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              const content: unknown = chunk.value;
              if (
                !content ||
                typeof content !== 'object' ||
                !('items' in content) ||
                !Array.isArray(content.items)
              )
                throw invalid('PDF returned malformed text content.');
              for (const item of content.items) {
                const value: unknown = item;
                if (
                  value &&
                  typeof value === 'object' &&
                  'str' in value &&
                  typeof value.str === 'string' &&
                  value.str.trim()
                ) {
                  pageHasText = hasText = true;
                  await text(value.str);
                }
              }
            }
          } finally {
            reader.releaseLock();
            page.cleanup();
          }
          if (!pageHasText)
            await text(
              '[No extractable text on this page; scanned or image-only pages require OCR.]',
            );
        }
      },
    );
    if (!hasText)
      throw new DocumentFailure(
        'DOCUMENT_NO_TEXT',
        'PDF contains no extractable text. Scanned or image-only PDFs require OCR.',
      );
  } finally {
    await task.destroy();
  }
}

function failure(error: unknown): DocumentReply {
  if (error instanceof DocumentFailure)
    return { ok: false, code: error.code, message: error.message };
  if (error instanceof Error) {
    if (error.name === 'PasswordException' || /password|encrypt/i.test(error.message))
      return { ok: false, code: 'DOCUMENT_PASSWORD_REQUIRED', message: password().message };
    if ('code' in error && ['ENOSPC', 'EDQUOT', 'EACCES', 'EROFS'].includes(String(error.code)))
      return {
        ok: false,
        code: 'DOCUMENT_WRITE_FAILED',
        message: 'Document text could not be written to the private output directory.',
      };
  }
  return {
    ok: false,
    code: 'DOCUMENT_INVALID',
    message: 'Document is damaged, unsupported, or does not match its declared format.',
  };
}

async function run(value: unknown): Promise<DocumentReply> {
  try {
    const job = documentJobSchema.parse(value);
    await validateSignature(job);
    if (job.operation === 'validate') return { ok: true, files: [], preview: '' };
    const output = new TextOutput(job.directory);
    if (job.mime === word) await docx(job, output);
    else if (job.mime === 'application/pdf') await pdf(job, output);
    else await spreadsheet(job, output);
    return output.result();
  } catch (error) {
    return failure(error);
  }
}

if (!parentPort) throw new Error('Document parser requires a worker channel.');
const channel = parentPort;
void run(workerData).then((result) => channel.postMessage(result));
