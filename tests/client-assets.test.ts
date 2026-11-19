import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';

test('client server serves hashed Vite assets and confines reads to the build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-client-assets-'));
  const assets = join(root, 'dist/client/assets');
  const file = '/assets/index-12345678.js';
  const pdfWorker = '/vendor/pdfjs/pdf.worker.min.mjs';
  const vendor = join(root, 'dist/client/vendor/pdfjs');
  await mkdir(assets, { recursive: true });
  await mkdir(vendor, { recursive: true });
  await writeFile(join(vendor, 'pdf.worker.min.mjs'), 'export {};');
  await writeFile(join(vendor, 'other.mjs'), 'export {};');
  await writeFile(
    join(root, 'dist/client/index.html'),
    `<script type="module" src="${file}"></script>`,
  );
  await writeFile(join(assets, 'index-12345678.js'), 'export {};');
  await writeFile(join(root, 'outside.js'), 'private');
  await symlink(join(root, 'outside.js'), join(assets, 'escape-12345678.js'));
  const app = await createApp({ root, data: join(root, 'data') });
  try {
    await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const index = await fetch(base);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('cache-control'), 'no-cache');
    assert.match(index.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.ok((await index.text()).includes(file));
    const asset = await fetch(base + file, { method: 'HEAD' });
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/);
    assert.match(asset.headers.get('content-type') ?? '', /text\/javascript/);
    assert.equal(await asset.text(), '');
    const worker = await fetch(base + pdfWorker);
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get('content-type') ?? '', /text\/javascript/);
    assert.equal(worker.headers.get('cache-control'), 'no-cache');
    assert.equal(await worker.text(), 'export {};');
    for (const path of [
      '/vendor/pdfjs/other.mjs',
      '/assets/escape-12345678.js',
      '/outside.js',
      '/api/unknown',
      '/assets/missing-12345678.js',
    ]) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
