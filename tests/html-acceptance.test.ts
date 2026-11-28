/**
 * @file Exercise the production static HTML verifier with real sandboxed Chromium and PDF output.
 * @implementation Cover mobile overflow, mismatched paper sizes, offline resources, isolation, cancellation and historical fixtures.
 * @updated 2026-11-28T19:34:00+08:00
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { verifyAcceptanceHtml } from '../server/modules/runs/html-acceptance.js';

const required = [
  '/usr/lib/chromium/chromium',
  '/usr/bin/bwrap',
  '/usr/bin/prlimit',
  '/usr/bin/timeout',
  '/usr/bin/pdfinfo',
  '/usr/bin/pdftoppm',
];
const available =
  process.platform === 'linux' &&
  process.arch === 'x64' &&
  process.getuid?.() !== 0 &&
  required.every((path) => existsSync(path)) &&
  spawnSync('/usr/bin/bwrap', ['--unshare-all', '--ro-bind', '/', '/', '/usr/bin/true'], {
    timeout: 3000,
  }).status === 0;
const integration = {
  skip: available
    ? false
    : 'Requires non-root Linux x64 with sandboxed Chromium, prlimit and pdfinfo.',
};
const signal = new AbortController().signal;
const request = { widths: [375, 1440], a4: true, singlePage: true, offline: true };
const statuses = (result: Awaited<ReturnType<typeof verifyAcceptanceHtml>>) =>
  Object.fromEntries(result.map((check) => [check.criterion, check.status]));

test(
  'measures static screen overflow and every page in a mixed paper size PDF',
  integration,
  async () => {
    const html = `<!doctype html><style>
    @page {size:A4} @page second {size:letter} section {page:second}
    @media screen {main {width:600px}} @media print {section {break-before:page}}
    </style><main>Page one</main><section>Page two</section>`;
    const result = await verifyAcceptanceHtml(html, request, signal);
    assert.deepEqual(
      statuses(result),
      {
        'html.width.375': 'failed',
        'html.width.1440': 'passed',
        'html.a4': 'failed',
        'html.singlePage': 'failed',
        'html.offline': 'passed',
      },
      JSON.stringify(result),
    );
    assert.match(
      result.find((r) => r.criterion === 'html.a4')?.detail ?? '',
      /page 2 measures 612 × 792.*@page \{ size: A4; \}/,
    );
  },
);

test('blocks document navigation, scripts and loopback resources', integration, async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end('unreachable');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/outside`;
    const html = `<!doctype html><meta http-equiv="refresh" content="0;url=${url}">
      <style>@page {size:A4} body{margin:0}</style><script>document.documentElement.style.minWidth='700px'</script><img src="${url}">`;
    const result = await verifyAcceptanceHtml(html, request, signal);
    assert.deepEqual(
      statuses(result),
      {
        'html.width.375': 'unverified',
        'html.width.1440': 'unverified',
        'html.a4': 'unverified',
        'html.singlePage': 'unverified',
        'html.offline': 'failed',
      },
      JSON.stringify(result),
    );
    assert.equal(requests, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test(
  'recognizes relative CSS, alternate image sources, script uncertainty and embedded data',
  integration,
  async () => {
    const cases = [
      ['<style>@import "theme.css"</style>', 'failed'],
      ['<style>@media(min-width:5000px){h1{background:url(./hero.webp)}}</style>', 'failed'],
      ['<img srcset="data:image/png;base64,AA== 1x, fallback.png 2x">', 'failed'],
      ['<script src="local.js"></script>', 'failed'],
      ['<script>document.title="dynamic"</script>', 'unverified'],
      ['<img srcset="data:image/png;base64,AA== 1x, data:image/png;base64,AA== 2x">', 'passed'],
    ];
    for (const [html, expected] of cases) {
      assert.ok(html);
      const result = await verifyAcceptanceHtml(
        '<p>Photo</p>' + html,
        { widths: [], a4: false, singlePage: false, offline: true },
        signal,
      );
      assert.equal(result[0]?.status, expected, JSON.stringify(result));
    }
  },
);

test(
  'incomplete or blank layouts cannot pass geometry even without an offline requirement',
  integration,
  async () => {
    const print = '<style>@page{size:A4}</style>';
    for (const content of [
      '',
      '<script>document.body.textContent="later"</script>',
      '<link rel="stylesheet" href="layout.css"><p>Body</p>',
    ]) {
      const result = await verifyAcceptanceHtml(
        print + content,
        { ...request, offline: false },
        signal,
      );
      assert.ok(
        result.every((check) => check.status === 'unverified'),
        JSON.stringify(result),
      );
    }
    const result = await verifyAcceptanceHtml(
      print +
        '<style>@media (max-width:400px),print {main{display:none}}</style><main>visible on desktop</main>',
      { ...request, offline: false },
      signal,
    );
    assert.deepEqual(
      statuses(result),
      {
        'html.width.375': 'unverified',
        'html.width.1440': 'passed',
        'html.a4': 'unverified',
        'html.singlePage': 'unverified',
      },
      JSON.stringify(result),
    );
  },
);

test('propagates cancellation and returns unverified for unsupported input budgets', async () => {
  const aborted = AbortSignal.abort(new Error('caller stopped'));
  await assert.rejects(verifyAcceptanceHtml('', request, aborted), /caller stopped/);
  const checks = await verifyAcceptanceHtml('', { ...request, widths: [10000] }, signal);
  assert.ok(checks.length && checks.every((item) => item.status === 'unverified'));
});

test('releases an in-flight verifier when its owning run is cancelled', integration, async () => {
  const controller = new AbortController();
  const stopping = setTimeout(() => controller.abort(new Error('stop verifier')), 50);
  try {
    await assert.rejects(
      verifyAcceptanceHtml('<div>hello</div>', request, controller.signal),
      /stop verifier/,
    );
  } finally {
    clearTimeout(stopping);
  }
});

const historical = '.local/task-plan-evaluation/verified-126';
test(
  'matches preserved verified-126 artifacts when present',
  {
    skip: integration.skip || (!existsSync(historical) && 'Local evaluation fixtures are absent.'),
  },
  async () => {
    for (const sample of ['baseline', 'current']) {
      const html = await readFile(`${historical}/1-html-${sample}/project/handout.html`, 'utf8');
      const result = await verifyAcceptanceHtml(html, request, signal);
      assert.deepEqual(
        statuses(result),
        {
          'html.width.375': sample === 'baseline' ? 'failed' : 'passed',
          'html.width.1440': 'passed',
          'html.a4': sample === 'baseline' ? 'passed' : 'failed',
          'html.singlePage': 'passed',
          'html.offline': 'passed',
        },
        JSON.stringify(result),
      );
    }
  },
);
