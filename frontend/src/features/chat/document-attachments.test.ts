/**
 * @file 验证文档附件上传、预览传输与大小分流。
 * @implementation 使用 fetch 和 QueryObserver 替身覆盖原始文件上传、既有 JSON、CSRF 重试、预览响应校验及取消；大表格不请求原件字节。
 * @updated 2026-11-21T00:00:00+08:00
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { QueryClient, QueryObserver, skipToken } from '@tanstack/react-query';
import type { Attachment } from '@shared/types';
import { documentAttachmentMime, documentPreviewBytes } from '@shared/document-attachments';
import { ApiError, apiBytes, bootstrap } from '@/api/client';
import { attachmentAccept, uploadAttachment } from '@/use-query/attachments/use-upload-attachment';
import {
  attachmentContentOptions,
  attachmentContentUrl,
  attachmentDownloadUrl,
  attachmentPreviewKind,
} from '@/use-query/attachments/use-attachment-content';
import { attachmentDocumentPreviewOptions } from '@/use-query/attachments/use-attachment-document-preview';

function attachment(name = 'plan.pdf', size = 12): Attachment {
  return {
    id: 'file/id?',
    sessionId: 'session/id?',
    name,
    mime: documentAttachmentMime(name) ?? 'text/plain',
    size,
    status: 'ready',
    createdAt: '2026-11-21T00:00:00+08:00',
  };
}

function mockFetch(
  t: TestContext,
  handler: (path: string, init?: RequestInit) => Promise<Response>,
) {
  t.mock.method(globalThis, 'fetch', (input: unknown, init?: RequestInit) => {
    const path = String(input);
    return path === '/api/bootstrap'
      ? Promise.resolve(Response.json({ csrfToken: 'attachment-test-token' }))
      : handler(path, init);
  });
}

test('all document types upload raw File bodies, including over 20 MiB, without eager reads', async (t) => {
  const files = [
    new File(['fixture'], '预算 & plan.XLS', { type: '' }),
    new File([new Uint8Array(documentPreviewBytes + 1)], 'large.XLSX', { type: 'text/plain' }),
    new File(['fixture'], 'report.PDF', { type: 'application/octet-stream' }),
    new File(['fixture'], 'notes.DOCX'),
  ];
  let sent = 0;
  mockFetch(t, async (path, init) => {
    const file = files[sent++];
    assert.ok(file);
    assert.equal(
      path,
      `/api/sessions/session%2Fid%3F/attachments?name=${encodeURIComponent(file.name)}`,
    );
    assert.equal(init?.method, 'POST');
    assert.equal(init.body, file);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Content-Type'), 'application/octet-stream');
    assert.equal(headers.get('X-Atelier-Token'), 'attachment-test-token');
    return Response.json({ attachment: attachment(file.name, file.size) });
  });
  await bootstrap();
  for (const file of files) {
    t.mock.method(file, 'arrayBuffer', () => {
      throw new Error('document upload must pass the File directly');
    });
    const result = await uploadAttachment('session/id?', file);
    assert.equal(result.name, file.name);
    assert.ok(
      attachmentAccept.split(',').includes(`.${file.name.split('.').at(-1)?.toLowerCase()}`),
    );
  }
  assert.equal(sent, files.length);
});

test('text and image uploads retain the existing JSON body and limits', async (t) => {
  const files = [
    new File(['hello 你好'], 'note.txt'),
    new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' }),
  ];
  let sent = 0;
  mockFetch(t, async (path, init) => {
    const file = files[sent++];
    assert.ok(file);
    assert.equal(path, '/api/sessions/session/attachments');
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
    const body: unknown = JSON.parse(String(init?.body));
    assert.deepEqual(body, {
      name: file.name,
      mime: file.type || 'text/plain',
      contentBase64: Buffer.from(await file.arrayBuffer()).toString('base64'),
    });
    return Response.json({ attachment: attachment(file.name, file.size) });
  });
  for (const file of files) await uploadAttachment('session', file);
  assert.equal(sent, 2);
  await assert.rejects(uploadAttachment('session', new File(['x'], 'unsupported.doc')), /XLS/);
  await assert.rejects(uploadAttachment('session', new File(['\0'], 'invalid.txt')), /UTF-8/);
  await assert.rejects(
    uploadAttachment('session', new File([new Uint8Array([0xff])], 'invalid.txt')),
    /UTF-8/,
  );
  await assert.rejects(
    uploadAttachment('session', new File([new Uint8Array(1024 * 1024 + 1)], 'large.txt')),
    /1 MiB/,
  );
  await assert.rejects(
    uploadAttachment('session', new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png')),
    /5 MiB/,
  );
  assert.equal(sent, 2);
});

test('raw upload retries CSRF renewal with the same original File body', async (t) => {
  const file = new File(['document'], 'report.pdf');
  let tokens = 0;
  let sends = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    if (String(input) === '/api/bootstrap')
      return Response.json({ csrfToken: `raw-token-${++tokens}` });
    sends++;
    assert.equal(init?.body, file);
    assert.equal(new Headers(init?.headers).get('X-Atelier-Token'), `raw-token-${sends}`);
    return sends === 1
      ? Response.json({ error: { code: 'TOKEN_REQUIRED', message: 'expired' } }, { status: 403 })
      : Response.json({ attachment: attachment() });
  });
  await bootstrap();
  await uploadAttachment('session', file);
  assert.equal(tokens, 2);
  assert.equal(sends, 2);
});

test('PDF and XLS/XLSX preview queries read raw bytes and preserve session/file keys', async (t) => {
  const bytes = new Uint8Array([0, 255, 1, 2]);
  mockFetch(t, async (path, init) => {
    assert.equal(path, '/api/sessions/session%2Fid%3F/attachments/file%2Fid%3F/content');
    assert.equal(init?.method, 'GET');
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(bytes);
  });
  for (const name of ['report.pdf', 'plan.xls', 'plan.xlsx']) {
    const item = attachment(name, documentPreviewBytes);
    const client = new QueryClient();
    try {
      const options = attachmentContentOptions(item, true);
      assert.deepEqual(options.queryKey, ['attachment-preview', item.sessionId, item.id]);
      assert.equal(options.enabled, true);
      const result = await client.fetchQuery(options);
      assert.equal(result.kind, 'binary');
      if (result.kind === 'binary') assert.deepEqual(new Uint8Array(result.bytes), bytes);
    } finally {
      client.clear();
    }
  }
});

test('DOCX queries parsed text using the original attachment ID; text keeps JSON content', async (t) => {
  const requested: string[] = [];
  mockFetch(t, async (path) => {
    requested.push(path);
    return Response.json({ text: 'preview text' });
  });
  const client = new QueryClient();
  try {
    const docx = attachment('notes.docx');
    const docxOptions = attachmentDocumentPreviewOptions(docx, true);
    assert.equal(attachmentPreviewKind(docx), 'document-text');
    assert.equal(attachmentContentOptions(docx, true).queryFn, skipToken);
    assert.deepEqual(docxOptions.queryKey, [
      'attachment-document-preview',
      docx.sessionId,
      docx.id,
    ]);
    assert.deepEqual(await client.fetchQuery(docxOptions), { text: 'preview text' });
    const text = attachment('notes.txt');
    assert.deepEqual(await client.fetchQuery(attachmentContentOptions(text, true)), {
      kind: 'text',
      text: 'preview text',
    });
    assert.deepEqual(requested, [
      '/api/sessions/session%2Fid%3F/attachments/file%2Fid%3F/document-preview',
      attachmentContentUrl(text),
    ]);
    assert.equal(
      attachmentDownloadUrl(docx),
      '/api/sessions/session%2Fid%3F/attachments/file%2Fid%3F/download',
    );
  } finally {
    client.clear();
  }
});

test('large spreadsheet dialogs never request content or parsed previews', (t) => {
  let requests = 0;
  mockFetch(t, async () => {
    requests++;
    throw new Error('large spreadsheet must not load into memory');
  });
  const client = new QueryClient();
  try {
    for (const name of ['large.xls', 'large.xlsx']) {
      const item = attachment(name, documentPreviewBytes + 1);
      assert.equal(attachmentPreviewKind(item), 'download');
      const content = attachmentContentOptions(item, true);
      const document = attachmentDocumentPreviewOptions(item, true);
      assert.equal(content.queryFn, skipToken);
      assert.equal(document.queryFn, skipToken);
      const contentObserver = new QueryObserver(client, content);
      const documentObserver = new QueryObserver(client, document);
      const closeContent = contentObserver.subscribe(() => {});
      const closeDocument = documentObserver.subscribe(() => {});
      closeContent();
      closeDocument();
    }
    assert.equal(requests, 0);
  } finally {
    client.clear();
  }
});

test('closed, removed and image previews do not start content queries', () => {
  const image = { ...attachment('image.png'), mime: 'image/png' };
  assert.equal(attachmentPreviewKind(image), 'image');
  assert.equal(attachmentContentOptions(image, true).enabled, false);
  assert.equal(attachmentContentOptions(attachment(), false).enabled, false);
  assert.equal(attachmentContentOptions({ ...attachment(), removed: true }, true).enabled, false);
  assert.equal(attachmentDocumentPreviewOptions(attachment('notes.docx'), false).enabled, false);
  assert.equal(
    attachmentDocumentPreviewOptions({ ...attachment('notes.docx'), removed: true }, true).enabled,
    false,
  );
});

test('preview JSON is validated and byte requests surface structured or non-JSON errors', async (t) => {
  mockFetch(t, async (path) => {
    if (path.endsWith('/document-preview') || path.endsWith('/content'))
      return Response.json({ text: 42 });
    return path === '/structured'
      ? Response.json({ error: { code: 'MISSING', message: 'file missing' } }, { status: 404 })
      : new Response('unavailable', { status: 503 });
  });
  const client = new QueryClient();
  try {
    await assert.rejects(
      client.fetchQuery(attachmentDocumentPreviewOptions(attachment('notes.docx'), true)),
      /string/,
    );
    await assert.rejects(
      client.fetchQuery(attachmentContentOptions(attachment('notes.txt'), true)),
      /string/,
    );
    await assert.rejects(
      apiBytes('/structured'),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 404 &&
        error.code === 'MISSING' &&
        error.message === 'file missing',
    );
    await assert.rejects(
      apiBytes('/unstructured'),
      (error: unknown) => error instanceof ApiError && error.status === 503,
    );
  } finally {
    client.clear();
  }
});

test('closing a pending binary preview cancels its transport', async (t) => {
  let signal: AbortSignal | undefined;
  mockFetch(t, async (_path, init) => {
    const current = init?.signal;
    assert.ok(current instanceof AbortSignal);
    signal = current;
    return new Promise((_resolve, reject) => {
      current.addEventListener('abort', () => reject(current.reason), { once: true });
    });
  });
  const client = new QueryClient();
  try {
    const options = attachmentContentOptions(attachment(), true);
    const pending = client.fetchQuery(options);
    const rejected = assert.rejects(pending);
    await client.cancelQueries({ queryKey: options.queryKey });
    await rejected;
    assert.equal(signal?.aborted, true);
  } finally {
    client.clear();
  }
});
