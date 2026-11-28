/**
 * @file Verify explicit static HTML delivery conditions in an isolated Linux Chromium.
 * @implementation Serve immutable bytes once, measure viewport overflow and inspect the printed PDF page boxes.
 * @updated 2026-11-28T19:34:00+08:00
 */
import { execFile } from 'node:child_process';
import type { CDPSession, Page } from 'playwright-core';

type Request = { widths: number[]; a4: boolean; singlePage: boolean; offline?: boolean };
type Result = { criterion: string; status: 'passed' | 'failed' | 'unverified'; detail: string };
const documentUrl = 'https://atelier-acceptance.invalid/document.html';
const maxPages = 64;

const sandbox = [
  '/usr/bin/bwrap',
  '--unshare-all',
  '--new-session',
  '--die-with-parent',
  '--clearenv',
  '--cap-drop',
  'ALL',
  '--ro-bind',
  '/usr/lib',
  '/usr/lib',
  '--ro-bind',
  '/lib',
  '/lib',
  '--ro-bind-try',
  '/lib64',
  '/lib64',
  '--ro-bind',
  '/usr/share/fonts',
  '/usr/share/fonts',
  '--ro-bind-try',
  '/usr/share/fontconfig',
  '/usr/share/fontconfig',
  '--ro-bind',
  '/etc/fonts',
  '/etc/fonts',
  '--ro-bind-try',
  '/etc/ld.so.cache',
  '/etc/ld.so.cache',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  '--size',
  '67108864',
  '--tmpfs',
  '/dev/shm',
  '--size',
  '134217728',
  '--tmpfs',
  '/tmp',
  '--setenv',
  'HOME',
  '/tmp',
  '--setenv',
  'LANG',
  'C.UTF-8',
];

async function launchBrowser() {
  // The wrapper must inherit Playwright's anonymous debugging pipe. No TCP listener, host
  // profile, project mount, session bus or command derived from document content is needed.
  const { chromium } = await import('playwright-core');
  return chromium.launch({
    executablePath: '/usr/bin/timeout',
    ignoreDefaultArgs: true,
    chromiumSandbox: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    env: { PATH: '/usr/bin', LANG: 'C.UTF-8' },
    timeout: 6000,
    args: [
      '--signal=KILL',
      '15s',
      '/usr/bin/prlimit',
      '--data=536870912',
      '--cpu=15',
      '--fsize=134217728',
      '--core=0',
      '--',
      ...sandbox,
      '--remount-ro',
      '/',
      '--chdir',
      '/tmp',
      '--',
      '/usr/lib/chromium/chromium',
      '--headless',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-setuid-sandbox',
      '--disable-extensions',
      '--disable-breakpad',
      '--renderer-process-limit=2',
      '--user-data-dir=/tmp/profile',
      '--remote-debugging-pipe',
      '--no-startup-window',
    ],
  });
}

// This function runs as trusted browser instrumentation. Scripts in the document stay disabled.
function inspectDependencies() {
  let external = false;
  let uncertain = false;
  const inspect = {
    url(raw: string) {
      const url = raw.trim();
      if (!url || url.startsWith('#')) return;
      if (!/^data:/iu.test(url)) external = true;
    },
    css(css: string) {
      // The browser normalizes ordinary CSS URLs, including escapes, before inspection.
      for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/giu))
        inspect.url(match[1] ?? match[2] ?? match[3] ?? '');
      if (/@import|(?:image-set|paint|src|image)\(/iu.test(css)) uncertain = true;
    },
    srcset(srcset: string) {
      // A data URL can itself contain commas. Candidate URLs terminate at whitespace,
      // with trailing commas separating descriptor-less candidates (HTML srcset algorithm).
      let rest = srcset.trim();
      while (rest) {
        const token = /^[^\s]+/u.exec(rest)?.[0] ?? '';
        inspect.url(token.replace(/,+$/u, ''));
        rest = rest.slice(token.length);
        if (!token.endsWith(',')) {
          const comma = rest.indexOf(',');
          rest = comma < 0 ? '' : rest.slice(comma + 1);
        }
        rest = rest.replace(/^[\s,]+/u, '');
      }
    },
  };
  const root = document.querySelectorAll('*');
  if (root.length > 20_000) return { external, uncertain: true };
  for (const element of root) {
    const tag = element.localName;
    for (const attr of element.attributes) {
      if (/^on/iu.test(attr.name) || /^\s*javascript:/iu.test(attr.value)) uncertain = true;
      if (['src', 'poster', 'background'].includes(attr.name)) inspect.url(attr.value);
      if (attr.name === 'srcset' || attr.name === 'imagesrcset') inspect.srcset(attr.value);
      if (attr.name === 'data' && tag === 'object') inspect.url(attr.value);
      if (
        attr.localName === 'href' &&
        ((tag === 'link' &&
          /(?:^|\s)(?:stylesheet|icon|manifest|preload|modulepreload|prefetch|preconnect|dns-prefetch)(?:$|\s)/iu.test(
            element.getAttribute('rel') ?? '',
          )) ||
          (element.namespaceURI === 'http://www.w3.org/2000/svg' && tag !== 'a'))
      )
        inspect.url(attr.value);
      if (
        attr.name === 'style' &&
        'style' in element &&
        element.style instanceof CSSStyleDeclaration
      )
        inspect.css(element.style.cssText);
      if (element.namespaceURI === 'http://www.w3.org/2000/svg') inspect.css(attr.value);
    }
    if (
      ['script', 'iframe', 'frame', 'object', 'embed', 'template'].includes(tag) ||
      (tag === 'meta' && element.getAttribute('http-equiv')?.toLowerCase() === 'refresh')
    )
      uncertain = true;
  }
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSImportRule) inspect.url(rule.href);
        inspect.css(rule.cssText);
      }
    } catch {
      uncertain = true;
    }
  }
  return { external, uncertain };
}

function inspectPdf(
  executable: '/usr/bin/pdfinfo' | '/usr/bin/pdftoppm',
  args: string[],
  pdf: Buffer,
  signal: AbortSignal,
) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      '/usr/bin/prlimit',
      [
        '--data=134217728',
        '--cpu=3',
        '--core=0',
        '--',
        ...sandbox,
        '--ro-bind',
        executable,
        executable,
        '--remount-ro',
        '/',
        '--chdir',
        '/tmp',
        '--',
        executable,
        ...args,
        '-',
      ],
      {
        encoding: 'buffer',
        timeout: 3500,
        killSignal: 'SIGKILL',
        signal,
        maxBuffer: 128 * 1024,
        env: { LC_ALL: 'C' },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.on('error', () => {}); // exit status carries early parser/exec failures
    child.stdin?.end(pdf);
  });
}

async function pdfMetadata(session: CDPSession, signal: AbortSignal) {
  // Letter is Chromium's ordinary fallback. Supplying A4 here would let a document with
  // no print rule pass. The extra page detects truncation without accepting a partial PDF.
  const { stream } = await session.send('Page.printToPDF', {
    preferCSSPageSize: true,
    paperWidth: 8.5,
    paperHeight: 11,
    marginTop: 0,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    pageRanges: `1-${maxPages + 1}`,
    transferMode: 'ReturnAsStream',
  });
  if (!stream) throw new Error('PDF stream unavailable');
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    signal.throwIfAborted();
    const chunk = await session.send('IO.read', { handle: stream, size: 64 * 1024 });
    const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
    total += bytes.length;
    if (total > 8 * 1024 * 1024) throw new Error('PDF exceeded the verification budget');
    chunks.push(bytes);
    if (chunk.eof) break;
  }
  await session.send('IO.close', { handle: stream });
  const pdf = Buffer.concat(chunks, total);
  const output = (
    await inspectPdf('/usr/bin/pdfinfo', ['-f', '1', '-l', String(maxPages + 1)], pdf, signal)
  ).toString('utf8');
  // Document titles can contain line breaks. Only read the final Poppler page table.
  const table = output.slice(output.lastIndexOf('\nPages:') + 1);
  const count = Number(/^Pages:\s+(\d+)$/mu.exec(table)?.[1]);
  const sizes = [...table.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts\b/gmu)];
  if (!count || sizes.length !== count || sizes.some((m, i) => Number(m[1]) !== i + 1))
    throw new Error('Incomplete PDF dimensions');
  const dimensions = sizes.map((m) => [Number(m[2]), Number(m[3])] as const);
  // Rasterize the actual first printed page. This also catches CSS that hides all content
  // specifically in print (and still produces a perfectly valid one-page A4 PDF).
  const pgm = await inspectPdf(
    '/usr/bin/pdftoppm',
    ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '256', '-gray'],
    pdf,
    signal,
  );
  const header = /^P5\n(\d+) (\d+)\n255\n/u.exec(pgm.subarray(0, 64).toString('latin1'));
  if (!header || pgm.length - header[0].length !== Number(header[1]) * Number(header[2]))
    throw new Error('Incomplete PDF preview');
  const pixels = pgm.subarray(header[0].length);
  return { count, dimensions, ink: pixels.some((pixel) => pixel !== pixels[0]) };
}

function hasVisibleContent() {
  const body = document.body;
  if (!body) return false;
  const options = { checkOpacity: true, checkVisibilityCSS: true };
  const nodes = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
    const parent = node.parentElement;
    if (!node.textContent?.trim() || !parent?.checkVisibility(options)) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0) return true;
  }
  return [
    ...body.querySelectorAll(
      'img,svg path,svg rect,svg circle,svg polygon,svg ellipse,svg line,svg use',
    ),
  ].some((item) => {
    if (item instanceof HTMLImageElement && !item.naturalWidth) return false;
    const rect = item.getBoundingClientRect();
    return (
      item.checkVisibility(options) &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0
    );
  });
}

async function inspectPage(page: Page, request: Request, signal: AbortSignal, results: Result[]) {
  for (const width of request.widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const size = await page.evaluate(() => ({
      width: innerWidth,
      scroll: (document.scrollingElement ?? document.documentElement).scrollWidth,
    }));
    if (size.width !== width || !size.scroll) throw new Error('Viewport unavailable');
    const visible = await page.evaluate(hasVisibleContent);
    results.push({
      criterion: `html.width.${width}`,
      status: !visible ? 'unverified' : size.scroll <= width ? 'passed' : 'failed',
      detail: `Static render at ${width} CSS px with scripts disabled: document scroll width ${size.scroll} px.${visible ? '' : ' No visible static text or graphic could be verified.'}`,
    });
  }
  if (request.a4 || request.singlePage) {
    const info = await pdfMetadata(await page.context().newCDPSession(page), signal);
    if (!info.ink) {
      const detail = `Chromium printed ${info.count} page(s); no visible marks were detected in the first printed page preview.`;
      if (request.a4) results.push({ criterion: 'html.a4', status: 'unverified', detail });
      if (request.singlePage)
        results.push({ criterion: 'html.singlePage', status: 'unverified', detail });
      return;
    }
    const mismatch = info.dimensions.find(
      ([w, h]) => Math.abs(Math.min(w, h) - 595.28) > 2 || Math.abs(Math.max(w, h) - 841.89) > 2,
    );
    if (request.a4)
      results.push({
        criterion: 'html.a4',
        status: mismatch ? 'failed' : info.count > maxPages ? 'unverified' : 'passed',
        detail: mismatch
          ? `Printed page ${info.dimensions.indexOf(mismatch) + 1} measures ${mismatch.join(' × ')} pt. Set physical paper size with CSS @page { size: A4; } for every printed page, including any named pages. Body width and margins only affect content layout.`
          : info.count > maxPages
            ? 'Full PDF exceeds the 64-page inspection budget.'
            : `All ${info.count} printed pages measure A4 (${info.dimensions[0]?.join(' × ')} pt on page 1).`,
      });
    if (request.singlePage)
      results.push({
        criterion: 'html.singlePage',
        status: info.count === 1 ? 'passed' : 'failed',
        detail: `Chromium printed ${info.count > maxPages ? 'at least ' : ''}${info.count} page(s).`,
      });
  }
}

export async function verifyAcceptanceHtml(
  html: string,
  requested: Request,
  signal: AbortSignal,
): Promise<Result[]> {
  signal.throwIfAborted();
  const request = { ...requested, widths: [...new Set(requested.widths)] };
  const criteria = request.widths.map((w) => `html.width.${w}`);
  if (request.a4) criteria.push('html.a4');
  if (request.singlePage) criteria.push('html.singlePage');
  if (request.offline) criteria.push('html.offline');
  const results: Result[] = [];
  const finish = (detail: string) =>
    criteria.map(
      (criterion) =>
        results.find((r) => r.criterion === criterion) ?? {
          criterion,
          status: 'unverified' as const,
          detail,
        },
    );
  if (!criteria.length) return [];
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0)
    return finish('Static HTML checks require a non-root Linux x64 Chromium sandbox.');
  if (
    Buffer.byteLength(html) > 1024 * 1024 ||
    request.widths.length > 12 ||
    request.widths.some((w) => !Number.isSafeInteger(w) || w < 1 || w > 8192)
  )
    return finish('Document size or requested viewports exceed the static HTML inspection budget.');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  const close = () => {
    void browser?.close().catch(() => {});
  };
  deadline.addEventListener('abort', close, { once: true });
  let phase = 'Isolated Chromium unavailable (requires Chromium, bubblewrap, timeout and prlimit).';
  try {
    browser = await launchBrowser();
    deadline.throwIfAborted();
    const ctx = await browser.newContext({
      javaScriptEnabled: false,
      offline: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    const page = await ctx.newPage();
    let served = false;
    let blocked = false;
    await ctx.route('**/*', (route) => {
      const req = route.request();
      if (
        served ||
        req.url() !== documentUrl ||
        !req.isNavigationRequest() ||
        req.frame() !== page.mainFrame()
      ) {
        blocked = true;
        return route.abort();
      }
      served = true;
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: Buffer.from(html),
        headers: {
          'Content-Security-Policy':
            "sandbox; default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'",
        },
      });
    });
    phase = 'The original static HTML document could not be rendered.';
    await page.goto(documentUrl, { waitUntil: 'load', timeout: 5000 });
    if (!served || page.url() !== documentUrl) return finish(phase);
    const { external, uncertain } = await page.evaluate(inspectDependencies);
    // A closed declarative shadow tree is consumed by the parser and hidden from DOM traversal.
    const incomplete = uncertain || /shadowrootmode\s*=/iu.test(html);
    const dependencies = {
      criterion: 'html.offline',
      status: external || blocked ? 'failed' : incomplete ? 'unverified' : 'passed',
      detail:
        external || blocked
          ? 'Document references a resource outside this HTML file.'
          : incomplete
            ? 'Scripted, nested or opaque resources prevent a complete offline check.'
            : 'Static resource inspection found only embedded dependencies.',
    } satisfies Result;
    if (request.offline) results.push(dependencies);
    if (dependencies.status !== 'passed')
      return finish(
        `Static render with scripts and external requests disabled cannot verify the complete layout. ${dependencies.detail}`,
      );
    if (request.offline && criteria.length === 1 && !(await page.evaluate(hasVisibleContent)))
      return [
        {
          criterion: 'html.offline',
          status: 'unverified',
          detail: 'No visible static text or graphic could be verified.',
        },
      ];
    phase =
      'Static rendering or PDF inspection could not complete within its limits (printing requires pdfinfo and pdftoppm).';
    await inspectPage(page, request, deadline, results);
    if (page.url() !== documentUrl) {
      results.length = 0;
      return finish('Document navigated during inspection.');
    }
    return finish(phase);
  } catch {
    signal.throwIfAborted();
    return finish(deadline.aborted ? 'Static HTML verification timed out.' : phase);
  } finally {
    deadline.removeEventListener('abort', close);
    await browser?.close().catch(() => {});
  }
}
