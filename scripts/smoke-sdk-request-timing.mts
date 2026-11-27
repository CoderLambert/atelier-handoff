/**
 * @file 验收真实 Electron 的 SDK 请求计时、等待提示与诊断持久化。
 * @implementation 使用隔离快照、真实 SDK 和分阶段回环 SSE 验证中英文 Electron 的请求配对、诊断下载与关闭重开。托管 Shunt 模式覆盖缺失响应标识和换端口后的续接。
 * @updated 2026-11-27T12:27:43+08:00
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { z } from 'zod';
import { runRequestTimingSchema, type RunRequestTiming } from '../shared/request-timing.js';
import { sendModelReply } from '../tests/fixtures/subagent-gateway.js';
import { until } from './p1-smoke/contracts.mjs';

// Reuse completed builds; this script never runs a build or changes live application data.
// Optional argument: an installed Electron executable. Development runs snapshot dist/client,
// dist/desktop, server and shared so later workspace edits cannot alter the running candidate.
const source = fileURLToPath(new URL('../', import.meta.url));
const installed = process.argv[2] ? resolve(process.argv[2]) : undefined;
// Opt in to the actual pinned resource binary; never synthesize trusted host environment.
const managed = process.env.ATELIER_TIMING_MANAGED_SHUNT === '1';
assert.ok(!managed || !installed, 'Managed Shunt mode uses the snapshotted development host');
const shuntSha256 = '4436580d9bdc93f14304ca794f20e52fd4fcdef03d017cfefec583c53bbe532b';
const evidence = resolve(
  process.env.ATELIER_TIMING_EVIDENCE ?? join(source, '.local/sdk-request-timing'),
);
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'atelier-sdk-request-timing-'));
const artifact = join(directory, 'candidate');
const model = 'fixture-sdk-request-timing';
const sample = 'SYNTHETIC_TIMING_READ_RECEIPT';
const answer = 'SYNTHETIC_TIMING_STREAM_COMPLETE';
const sdkVersion = z
  .object({ version: z.literal('0.3.332') })
  .parse(
    JSON.parse(
      await readFile(
        join(source, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
        'utf8',
      ),
    ),
  ).version;
const requestSchema = z.object({
  model: z.literal(model),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  tools: z.array(z.object({ name: z.string() })),
});
const detailSchema = z.object({
  run: z.object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    status: z.string(),
    error: z.string().nullable(),
    executor: z.literal('native-v1'),
    requestTiming: runRequestTimingSchema.optional(),
  }),
  tools: z.array(
    z.object({ name: z.string(), status: z.string(), endedAt: z.string().nullable() }),
  ),
  events: z.array(z.object({ type: z.string(), at: z.string() })),
});
const diagnosticSchema = z.object({
  run: z.object({ id: z.string().uuid(), status: z.literal('completed') }),
  requestTiming: runRequestTimingSchema,
});
function gate() {
  let release = () => {};
  const ready = new Promise<void>((done) => {
    release = done;
  });
  return { ready, release };
}
const results: unknown[] = [];
let app: ElectronApplication | undefined;
let passed = false;
let stage = 'snapshot';
try {
  if (!installed) {
    await mkdir(join(artifact, 'dist'), { recursive: true });
    await Promise.all([
      ...['server', 'shared', 'package.json', 'tsconfig.json'].map((path) =>
        cp(join(source, path), join(artifact, path), { recursive: true }),
      ),
      cp(join(source, 'dist/client'), join(artifact, 'dist/client'), { recursive: true }),
      cp(join(source, 'dist/desktop'), join(artifact, 'dist/desktop'), { recursive: true }),
      symlink(join(source, 'node_modules'), join(artifact, 'node_modules'), 'dir'),
    ]);
    const inputs = await Promise.all(
      [
        'dist/desktop/main.mjs',
        'dist/desktop/preload.cjs',
        'dist/client/index.html',
        'server/request-timing.ts',
        'server/sdk-request-traces.ts',
        'server/sdk-resume.ts',
      ].map(async (path) => ({
        path,
        sha256: createHash('sha256')
          .update(await readFile(join(artifact, path)))
          .digest('hex'),
      })),
    );
    await writeFile(join(evidence, 'candidate-inputs.json'), JSON.stringify(inputs, null, 2));
  }
  if (managed) {
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    const binary = join(source, 'dist/linux/atelier/resources/shunt/shunt');
    assert.equal(
      createHash('sha256')
        .update(await readFile(binary))
        .digest('hex'),
      shuntSha256,
      'Shunt must match the audited 0.64.0 resource in scripts/linux/package.mts',
    );
    await mkdir(join(artifact, 'dist/linux/atelier/resources/shunt'), { recursive: true });
    await cp(binary, join(artifact, 'dist/linux/atelier/resources/shunt/shunt'));
  }
  for (const language of managed ? (['zh'] as const) : (['zh', 'en'] as const)) {
    const root = join(directory, language);
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    await mkdir(join(root, 'home'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(join(project, 'timing.txt'), sample);
    const firstEvent = gate(),
      firstContent = gate(),
      streamEnd = gate();
    const followup = gate(),
      observedEvent = gate(),
      observedContent = gate();
    const failures: string[] = [];
    const times = { request: 0, firstEvent: 0, firstContent: 0, end: 0 };
    const toolId = 'toolu_timing_' + language;
    let requests = 0;
    const gateway = createServer(async (request, response) => {
      try {
        const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method === 'GET') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(pathname === '/routes' ? { data: [{ model }] } : {}));
          return;
        }
        if (pathname !== '/v1/messages') {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const parsed = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        requests++;
        if (requests === 1) {
          assert.ok(parsed.tools.some(({ name }) => name === 'Read'));
          sendModelReply(response, model, [
            { name: 'Read', id: toolId, input: { file_path: join(project, 'timing.txt') } },
          ]);
          return;
        }
        if (managed && requests === 3) {
          assert.ok(
            JSON.stringify(parsed.messages).includes(sample),
            'Resumed SDK must retain the hidden native Read result across the real managed port change',
          );
          assert.ok(JSON.stringify(parsed.messages).includes(answer));
          sendModelReply(response, model, 'SYNTHETIC_MANAGED_RESUME_COMPLETE');
          return;
        }
        assert.equal(requests, 2, 'Only the native Read and its continuation may call the model');
        const toolResults = parsed.messages
          .filter(({ role }) => role === 'user')
          .flatMap(({ content }) => (Array.isArray(content) ? content : []))
          .flatMap((value: unknown) => {
            const result = z
              .object({
                type: z.literal('tool_result'),
                tool_use_id: z.literal(toolId),
                content: z.unknown(),
                is_error: z.boolean().optional(),
              })
              .safeParse(value);
            return result.success ? [result.data] : [];
          });
        assert.equal(toolResults.length, 1);
        assert.notEqual(toolResults[0]?.is_error, true);
        assert.ok(
          JSON.stringify(toolResults[0]?.content).includes(sample),
          'Continuation contains the actual native Read receipt',
        );
        times.request = Date.now();
        followup.release();
        await firstEvent.ready;
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          // The real Responses bridge also commits its stream without this header.
          ...(!managed && { 'request-id': randomUUID() }),
        });
        const send = (type: string, fields: object = {}) =>
          response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        const usage = {
          input_tokens: 20,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        };
        times.firstEvent = Date.now();
        send('message_start', {
          message: {
            id: 'msg_' + randomUUID(),
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...usage, output_tokens: 0 },
          },
        });
        observedEvent.release();
        await firstContent.ready;
        times.firstContent = Date.now();
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
        observedContent.release();
        await streamEnd.ready;
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage });
        send('message_stop');
        times.end = Date.now();
        response.end();
      } catch (error) {
        failures.push(String(error));
        response.writeHead(500).end();
      }
    });
    try {
      await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
      const address = gateway.address();
      assert.ok(address && typeof address === 'object');
      if (managed) {
        await mkdir(join(root, 'data/shunt'), { recursive: true });
        await writeFile(
          join(root, 'data/shunt/shunt.toml'),
          `[server]\nbind = "127.0.0.1:0"\ndefault_provider = "local"\nshutdown_timeout_seconds = 2\n\n[server.auth]\ntokens_env = "ATELIER_SHUNT_CLIENT_TOKENS"\n\n[providers.local]\nkind = "anthropic"\nbase_url = "http://127.0.0.1:${address.port}"\nauth = "passthrough"\n\n[[routes]]\nmodel = "${model}"\nprovider = "local"\n`,
          { mode: 0o600 },
        );
      }
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^(ATELIER_|ANTHROPIC_|CLAUDE_|SHUNT_)/u.test(key)) delete env[key];
      }
      const launch = async () => {
        const desktop = await _electron.launch({
          executablePath: installed ?? join(source, 'node_modules/electron/dist/electron'),
          args: [
            ...(installed ? [] : [join(artifact, 'dist/desktop/main.mjs')]),
            '--user-data-dir=' + join(root, 'profile'),
            '--disable-gpu',
            ...(process.env.ATELIER_TIMING_HEADLESS === '1' ? ['--ozone-platform=headless'] : []),
          ],
          env: {
            ...env,
            HOME: join(root, 'home'),
            XDG_CONFIG_HOME: join(root, 'home/.config'),
            XDG_DATA_HOME: join(root, 'home/.local/share'),
            XDG_CACHE_HOME: join(root, 'home/.cache'),
            TMPDIR: join(root, 'tmp'),
            ATELIER_DATA_DIR: join(root, 'data'),
            ATELIER_PORT: '0',
            ...(managed
              ? {}
              : {
                  ATELIER_GATEWAY: 'http://127.0.0.1:' + address.port,
                  ATELIER_GATEWAY_TOKEN: 'synthetic-timing-fixture',
                }),
            ATELIER_MODEL: model,
            ATELIER_NATIVE_EXECUTION: '1',
            ATELIER_MAGPIE_URL: '',
          },
          timeout: 30_000,
        });
        app = desktop;
        desktop
          .process()
          .stderr?.on('data', (chunk: Buffer) => console.error(chunk.toString('utf8')));
        const page = await desktop.firstWindow();
        page.setDefaultTimeout(15_000);
        await page.waitForURL('http://127.0.0.1:*/**');
        await desktop.evaluate(
          ({ BrowserWindow }, size) =>
            BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
          language === 'zh' ? { width: 1440, height: 900 } : { width: 1280, height: 800 },
        );
        return { desktop, page };
      };
      const getDetail = async (page: Page, runId: string) => {
        // Read through the actual trusted renderer so main applies desktop pairing.
        const value: unknown = await page.evaluate(async (id) => {
          const response = await fetch('/api/runs/' + encodeURIComponent(id));
          if (!response.ok)
            throw new Error('Run detail HTTP ' + response.status + ': ' + (await response.text()));
          return response.json();
        }, runId);
        return detailSchema.parse(value);
      };
      const managedState = async (page: Page, sessionId: string) => {
        const values = await page.evaluate(async (id) => {
          const config = await fetch('/api/config');
          const snapshot = await fetch('/api/sessions/' + encodeURIComponent(id));
          if (!config.ok || !snapshot.ok) throw new Error('Cannot read managed resume state');
          return { config: await config.json(), snapshot: await snapshot.json() };
        }, sessionId);
        return z
          .object({
            config: z.object({
              config: z.object({ gateway: z.string().url(), managedGateway: z.literal(true) }),
            }),
            snapshot: z.object({
              session: z.object({ sdkSessionId: z.string().uuid(), sdkConfigKey: z.string() }),
            }),
          })
          .parse(values);
      };
      const showTrace = async (page: Page) => {
        await page
          .getByRole('tab', { name: language === 'zh' ? /执行轨迹/u : /Activity/u })
          .click();
        const trace = page.getByRole('region', {
          name: language === 'zh' ? '运行执行轨迹' : 'Run execution trace',
          exact: true,
        });
        await trace.waitFor();
        const timing = trace.locator('section[aria-labelledby="inspector-request-timing-heading"]');
        await timing
          .getByRole('heading', {
            name: language === 'zh' ? '模型请求计时' : 'Model request timings',
            exact: true,
          })
          .waitFor();
        assert.equal(await timing.locator('ol > li').count(), 2);
        for (const label of language === 'zh'
          ? ['请求跨度', '请求至首个内容事件', '首流至首个内容事件', '首流至流结束']
          : [
              'Request span',
              'Request to first content event',
              'First stream event to first content',
              'First stream event to end',
            ]) {
          await timing.getByText(label, { exact: true }).first().waitFor();
        }
        const continuation = timing.locator('ol > li').nth(1);
        for (const label of language === 'zh'
          ? ['上次工具结束至请求开始', '请求开始至首流']
          : ['Last tool finish to request start', 'Request start to first stream event']) {
          const fact = continuation
            .locator('dl > div')
            .filter({ has: page.getByText(label, { exact: true }) });
          await fact.waitFor();
          assert.match(await fact.locator('dd').innerText(), /[\d.,]+\s*(?:毫秒|秒|ms|s)/u);
        }
        assert.equal(
          await timing
            .getByText(language === 'zh' ? '请求跨度未关联' : 'Request span unlinked', {
              exact: true,
            })
            .count(),
          0,
        );
        return { trace, timing };
      };
      const download = async (desktop: ElectronApplication, page: Page, path: string) => {
        const done = desktop.evaluate(
          ({ BrowserWindow }, path) =>
            new Promise<string>((resolve, reject) => {
              const window = BrowserWindow.getAllWindows()[0];
              if (!window) throw new Error('Missing timing test window');
              const timer = setTimeout(
                () => reject(new Error('No completed diagnostic download')),
                15_000,
              );
              window.webContents.session.once('will-download', (_event, item) => {
                item.setSavePath(path);
                item.once('done', (_event, state) => {
                  clearTimeout(timer);
                  if (state === 'completed') resolve(item.getFilename());
                  else reject(new Error('Diagnostic download ended as ' + state));
                });
              });
            }),
          path,
        );
        await Promise.all([
          done,
          page
            .getByRole('link', {
              name: language === 'zh' ? '下载诊断 JSON' : 'Download diagnostic JSON',
              exact: true,
            })
            .click(),
        ]);
        return diagnosticSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      };
      stage = language + ':launch';
      const first = await launch();
      const { page } = first;
      const bind = page.getByRole('dialog', { name: '绑定项目目录' });
      await bind.getByLabel('本机目录').fill(project);
      await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
      await bind.waitFor({ state: 'hidden' });
      if (language === 'en') {
        const session = page.url();
        await page.goto(new URL('/#/settings/models', session).href);
        await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
        await page.getByRole('option', { name: 'English', exact: true }).click();
        await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
        await page.goto(session);
      }
      assert.equal(
        await page.locator('html').getAttribute('lang'),
        language === 'zh' ? 'zh-CN' : 'en',
      );
      stage = language + ':native-read';
      await page
        .locator('#prompt-input')
        .fill('Read timing.txt and wait for the staged synthetic response.');
      await page.locator('#prompt-input').press('Enter');
      await Promise.race([
        followup.ready,
        delay(20_000, undefined, { ref: false }).then(() => {
          throw new Error('Native Read continuation missing: ' + failures.join('\n'));
        }),
      ]);
      const live = page.locator('[data-run-live-status]');
      await live
        .getByRole('status')
        .filter({
          hasText: language === 'zh' ? '正在等待模型回复' : 'Waiting for the model to reply',
        })
        .waitFor();
      const runId = await live.getAttribute('data-run-id');
      assert.ok(runId);
      const read = await until(
        async () => {
          const detail = await getDetail(page, runId);
          return detail.tools.find(
            ({ name, status, endedAt }) =>
              name === 'Read' && status === 'succeeded' && endedAt !== null,
          );
        },
        5_000,
        'native Read receipt in persisted run',
      );
      assert.ok(read.endedAt);
      stage = language + ':since-activity';
      const idle = live.locator('[data-run-since-activity]');
      await idle.waitFor();
      const before = await idle.innerText();
      await page.waitForFunction(
        ({ before, elapsedSince }) => {
          const text = document.querySelector('[data-run-since-activity]')?.textContent?.trim();
          return text !== undefined && text !== before && Date.now() - elapsedSince >= 2_300;
        },
        { before, elapsedSince: Date.parse(read.endedAt) },
      );
      const sinceActivity = await idle.innerText();
      assert.match(
        sinceActivity,
        language === 'zh' ? /距上次活动\s+[\d.,]+\s*秒/u : /Since last activity\s+[\d.,]+\s*s/u,
      );
      assert.match(
        await live.locator('[data-run-elapsed]').innerText(),
        language === 'zh' ? /本轮用时/u : /Turn elapsed/u,
      );
      await page.screenshot({ path: join(evidence, 'waiting-' + language + '.png') });
      firstEvent.release();
      await observedEvent.ready;
      await delay(350);
      firstContent.release();
      await observedContent.ready;
      await page.getByText(answer, { exact: true }).first().waitFor();
      await delay(350);
      streamEnd.release();
      stage = language + ':timing';
      const ended = await until(
        async () => {
          const detail = await getDetail(page, runId);
          assert.notEqual(detail.run.status, 'failed', detail.run.error ?? 'SDK run failed');
          return detail.run.status === 'completed' ? detail : undefined;
        },
        20_000,
        'completed native SDK run',
      );
      const timing: RunRequestTiming | undefined = ended.run.requestTiming;
      assert.ok(timing);
      assert.equal(timing.records.length, 2, JSON.stringify(timing));
      assert.equal(timing.omitted, 0);
      assert.ok(
        timing.records.every(({ request, stream }) => request && stream?.outcome === 'complete'),
      );
      const continuation = timing.records[1];
      assert.ok(continuation?.request && continuation.stream?.lastToolFinishedAt);
      const { request: span, stream } = continuation;
      assert.ok(stream.lastToolFinishedAt);
      assert.ok((span.ttftMs ?? 0) >= 2_000, JSON.stringify(timing));
      assert.ok((span.firstContentMs ?? 0) >= (span.ttftMs ?? 0) + 250);
      assert.ok(span.durationMs >= (span.firstContentMs ?? 0) + 250);
      assert.ok(stream.firstEventAt - stream.lastToolFinishedAt >= 2_000);
      assert.ok((stream.firstContentAfterEventMs ?? 0) >= 250);
      assert.ok(stream.durationMs >= 600);
      assert.ok(ended.events.some(({ type }) => type === 'sdk.initialized'));
      await live.waitFor({ state: 'hidden' });
      const sessionHash = new URL(page.url()).hash;
      const firstTrace = await showTrace(page);
      await firstTrace.timing.screenshot({ path: join(evidence, 'timings-' + language + '.png') });
      await page.screenshot({ path: join(evidence, 'trace-' + language + '.png'), fullPage: true });
      stage = language + ':download';
      const diagnostic = await download(
        first.desktop,
        page,
        join(evidence, 'diagnostics-' + language + '.json'),
      );
      assert.equal(diagnostic.run.id, runId);
      assert.deepEqual(diagnostic.requestTiming, timing);
      assert.doesNotMatch(JSON.stringify(diagnostic.requestTiming), /SYNTHETIC_|toolu_|msg_/u);
      const beforeManaged = managed ? await managedState(page, ended.run.sessionId) : undefined;
      const pid = first.desktop.process().pid;
      stage = language + ':reopen';
      await first.desktop.close();
      app = undefined;
      const second = await launch();
      assert.notEqual(second.desktop.process().pid, pid);
      await second.page.goto(new URL('/' + sessionHash, second.page.url()).href);
      assert.equal(
        await second.page.locator('html').getAttribute('lang'),
        language === 'zh' ? 'zh-CN' : 'en',
      );
      await second.page.getByText(answer, { exact: true }).first().waitFor();
      const reopened = await getDetail(second.page, runId);
      assert.equal(reopened.run.status, 'completed');
      assert.deepEqual(reopened.run.requestTiming, timing);
      const reopenedTrace = await showTrace(second.page);
      await reopenedTrace.timing.screenshot({
        path: join(evidence, 'timings-reopened-' + language + '.png'),
      });
      const afterRestart = await download(
        second.desktop,
        second.page,
        join(evidence, 'diagnostics-reopened-' + language + '.json'),
      );
      assert.deepEqual(afterRestart.requestTiming, timing);
      await second.page.screenshot({
        path: join(evidence, 'reopened-' + language + '.png'),
        fullPage: true,
      });
      assert.equal(requests, 2, 'Reopen and diagnostic inspection must not call the model');
      let managedResume:
        | {
            beforeGateway: string;
            afterGateway: string;
            sdkSessionId: string;
            hiddenReadPreserved: boolean;
          }
        | undefined;
      if (beforeManaged) {
        stage = language + ':managed-resume';
        const reopenedState = await managedState(second.page, ended.run.sessionId);
        const beforeGateway = beforeManaged.config.config.gateway;
        const afterGateway = reopenedState.config.config.gateway;
        assert.notEqual(
          afterGateway,
          beforeGateway,
          'Real managed Shunt must use a different dynamic port after restart',
        );
        assert.equal(
          reopenedState.snapshot.session.sdkSessionId,
          beforeManaged.snapshot.session.sdkSessionId,
        );
        await second.page.goto(new URL('/' + sessionHash, second.page.url()).href);
        await second.page
          .locator('#prompt-input')
          .fill('Continue from the saved native Read result after the managed gateway restart.');
        await second.page.locator('#prompt-input').press('Enter');
        await second.page
          .getByText('SYNTHETIC_MANAGED_RESUME_COMPLETE', { exact: true })
          .first()
          .waitFor();
        await second.page.locator('[data-run-live-status]').waitFor({ state: 'hidden' });
        const resumed = await managedState(second.page, ended.run.sessionId);
        assert.equal(
          resumed.snapshot.session.sdkSessionId,
          beforeManaged.snapshot.session.sdkSessionId,
        );
        assert.equal(
          resumed.snapshot.session.sdkConfigKey,
          beforeManaged.snapshot.session.sdkConfigKey,
        );
        assert.equal(requests, 3);
        managedResume = {
          beforeGateway,
          afterGateway,
          sdkSessionId: resumed.snapshot.session.sdkSessionId,
          hiddenReadPreserved: true,
        };
        await second.page.screenshot({
          path: join(evidence, 'managed-resumed-' + language + '.png'),
        });
      }
      assert.deepEqual(failures, []);
      results.push({
        language,
        runId,
        sinceActivity,
        requestTiming: timing,
        syntheticStagesMs: {
          beforeFirstEvent: times.firstEvent - times.request,
          beforeFirstContent: times.firstContent - times.firstEvent,
          beforeEnd: times.end - times.firstContent,
        },
        downloadedBeforeAndAfterRestart: true,
        persistedAfterRestart: true,
        ...(managedResume ? { managedResume } : {}),
        requests,
      });
    } catch (error) {
      await app
        ?.firstWindow()
        .then((page) => page.screenshot({ path: join(evidence, 'failure-' + language + '.png') }))
        .catch(() => undefined);
      await writeFile(
        join(evidence, 'fixture-errors-' + language + '.json'),
        JSON.stringify({ stage, failures, requests, times }, null, 2),
      );
      throw error;
    } finally {
      firstEvent.release();
      firstContent.release();
      streamEnd.release();
      await app?.close().catch(() => undefined);
      app = undefined;
      gateway.closeAllConnections();
      await new Promise<void>((done) => gateway.close(() => done()));
    }
  }
  passed = true;
  const report = {
    result: 'passed',
    sdkVersion,
    installed: Boolean(installed),
    realElectron: true,
    runtime: installed ? 'installed runtime' : 'isolated source snapshot',
    modelTransport: 'synthetic loopback SSE',
    paidModelCalls: 0,
    managedShuntDynamicPortResume: managed
      ? { verified: true, shuntVersion: '0.64.0', shuntSha256 }
      : 'not exercised in the external gateway scenario; enable ATELIER_TIMING_MANAGED_SHUNT=1 for the actual pinned Shunt resource',
    results,
  };
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(
    join(evidence, 'failure.json'),
    JSON.stringify({ stage, error: String(error), directory, results }, null, 2),
  );
  await app
    ?.firstWindow()
    .then((page) => page.screenshot({ path: join(evidence, 'failure.png') }))
    .catch(() => undefined);
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  if (passed) await rm(directory, { recursive: true, force: true });
  else console.error('Failed timing smoke fixture retained at ' + directory);
}
