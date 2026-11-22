/**
 * @file 验证共享工具详情的命令、回执、原始文本回退及可访问交互。
 * @implementation 使用本地合成 ToolCall 和隔离 Chromium 检查参数格式化、真实状态、长输出入口及不同容器宽度，不读取用户数据或调用模型。
 * @updated 2026-11-22T18:42:04+08:00
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { compile } from '@tailwindcss/node';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { ToolCall } from '@shared/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolDetail, ToolDetailBody, toolCallSummary as rendererSummary } from './tool-detail';
import {
  splitCommandForDisplay,
  toolCallSummary,
  toolDisplayStatus,
  toolInputView,
  toolOutputMessage,
  toolOutputPresentation,
  toolOutputView,
} from './tool-detail-format';

function tool(patch: Partial<ToolCall> & { command?: string } = {}): ToolCall {
  return {
    id: 'tool-fixture',
    runId: 'run-fixture',
    sessionId: 'session-fixture',
    name: 'Bash',
    inputSummary: JSON.stringify({ command: 'printf fixture', description: '打印测试内容' }),
    status: 'succeeded',
    output: JSON.stringify({ stdout: 'fixture\n', stderr: '', interrupted: false }),
    startedAt: '2026-11-22T10:00:00.000Z',
    endedAt: '2026-11-22T10:00:01.000Z',
    ...patch,
  };
}

test('renderer public exports load in Node without importing CSS and the body renders without an outer disclosure', () => {
  const value = tool();
  assert.equal(typeof ToolDetail, 'function');
  assert.equal(rendererSummary(value), toolCallSummary(value));
  const markup = renderToStaticMarkup(
    createElement(ToolDetailBody, { tool: value, automaticallyApproved: false }),
  );
  assert.doesNotMatch(markup, /<details/u);
  assert.match(markup, /printf fixture/u);
  assert.match(markup, /stdout/u);
});

test('tool summary uses the recorded command ahead of JSON input, preserves multiline command in details, and identifies other tools', () => {
  const command = 'printf first\nnode -e "console.log(\'second\')"';
  const value = tool({
    command,
    inputSummary: JSON.stringify({
      command: 'old command',
      description: '打印内容',
      timeout: 1000,
    }),
  });
  assert.equal(toolCallSummary(value), 'Bash · printf first node -e "console.log(\'second\')"');
  assert.equal(toolInputView(value).command, command);
  assert.equal(toolInputView(value).explanation, '打印内容');
  assert.equal(toolInputView(value).parameters, '{\n  "timeout": 1000\n}');
  assert.equal(
    toolCallSummary(
      tool({ name: 'Read', inputSummary: '{"file_path":"/fixture/source.ts","limit":20}' }),
    ),
    'Read · /fixture/source.ts',
  );
  assert.equal(
    toolCallSummary(tool({ name: 'mcp__atelier__weather_lookup', inputSummary: '' })),
    'weather_lookup',
  );
});

const semicolonCommand = String.raw`printf 'first;\n'; export SAMPLE=$(printf x; printf y); printf '%s\n' "$SAMPLE"`;

test('shell display breaks between top-level statements and preserves source characters', () => {
  const lines = splitCommandForDisplay(semicolonCommand);
  assert.deepEqual(lines, [
    String.raw`printf 'first;\n'; `,
    'export SAMPLE=$(printf x; printf y); ',
    String.raw`printf '%s\n' "$SAMPLE"`,
  ]);
  assert.equal(lines.join(''), semicolonCommand);
  const escaped = String.raw`printf a\;b; printf $'it\'s; OK'; echo done;`;
  assert.equal(splitCommandForDisplay(escaped).length, 3);
  assert.equal(splitCommandForDisplay(escaped).join(''), escaped);
});

test('shell display preserves multiline or ambiguous shell sources as written', () => {
  for (const command of [
    'printf first; printf second\nprintf third',
    'cat <<EOF; echo done',
    'echo a; echo b # c; echo d',
    'echo a; echo "$(printf x; printf y)"',
    'case x in x) echo y;; esac',
    "echo a; printf 'unfinished; tail",
  ]) {
    assert.deepEqual(splitCommandForDisplay(command), [command]);
  }
});

test('truncated or non-JSON historical input is kept verbatim without claiming a recovered command', () => {
  const fragment = '{"command":"printf ' + 'x'.repeat(3980);
  const view = toolInputView(tool({ inputSummary: fragment }));
  assert.equal(view.command, undefined);
  assert.equal(view.parameters, fragment);
  assert.equal(view.rawInput, true);
  assert.ok(view.target.includes('printf'));
  assert.ok(view.target.length <= 180);
  const preserved = toolInputView(tool({ command: 'printf complete', inputSummary: fragment }));
  assert.equal(preserved.command, 'printf complete');
  assert.equal(preserved.parameters, fragment);
  assert.equal(
    toolInputView(tool({ inputSummary: 'printf old-history' })).command,
    'printf old-history',
  );
  assert.equal(
    toolInputView(tool({ inputSummary: '"printf string-history"' })).command,
    'printf string-history',
  );
});

test('native Bash receipt keeps streams separate and does not infer an exit code from success or output text', () => {
  const value = tool({
    output: JSON.stringify({ stdout: 'exit code 7\n', stderr: 'warning\n', interrupted: false }),
  });
  assert.deepEqual(toolOutputView(value), {
    sections: [
      { label: 'stdout', text: 'exit code 7\n' },
      { label: 'stderr', text: 'warning\n' },
    ],
    exitCode: undefined,
    interrupted: false,
    backgroundTaskId: undefined,
    truncated: false,
  });
  assert.equal(toolDisplayStatus(value, toolOutputView(value)), 'succeeded');
  for (const key of ['exitCode', 'exit_code', 'code']) {
    const coded = tool({
      output: JSON.stringify({ stdout: '', stderr: 'failed', interrupted: false, [key]: 2 }),
    });
    assert.equal(toolOutputView(coded).exitCode, 2);
    assert.equal(toolDisplayStatus(coded, toolOutputView(coded)), 'failed');
  }
});

test('native interruption and background acknowledgment remain distinct from completed empty output', () => {
  const interrupted = tool({
    output: JSON.stringify({ stdout: '', stderr: '', interrupted: true }),
  });
  assert.equal(toolDisplayStatus(interrupted, toolOutputView(interrupted)), 'interrupted');
  assert.equal(toolOutputMessage(interrupted, toolOutputView(interrupted)), '命令已中断。');
  const background = tool({
    output: JSON.stringify({
      stdout: '',
      stderr: '',
      interrupted: false,
      backgroundTaskId: 'task-fixture',
    }),
  });
  assert.equal(toolDisplayStatus(background, toolOutputView(background)), 'running');
  assert.match(
    toolOutputMessage(background, toolOutputView(background)) ?? '',
    /后台.*等待最终回执/u,
  );
  const empty = tool({ output: JSON.stringify({ stdout: '', stderr: '', interrupted: false }) });
  assert.equal(toolOutputMessage(empty, toolOutputView(empty)), '（无输出）');
  const canceled = tool({ status: 'canceled', output: '' });
  assert.match(toolOutputMessage(canceled, toolOutputView(canceled)) ?? '', /已取消/u);
});

test('controlled command success and failure use actual merged-output receipts and available code', () => {
  const value = tool({
    name: 'mcp__atelier__run_command',
    inputSummary: '{"command":"printf fixture","reason":"验证命令"}',
    output: '{"output":"fixture\\n","code":0,"truncated":false}',
  });
  assert.equal(toolInputView(value).explanation, '验证命令');
  assert.equal(toolCallSummary(value), 'run_command · printf fixture');
  assert.deepEqual(toolOutputView(value), {
    sections: [{ label: 'stdout / stderr（合并）', text: 'fixture\n' }],
    exitCode: 0,
    truncated: false,
  });
  const failure = tool({
    name: 'run_command',
    status: 'failed',
    output: '命令退出 7\nfixture error',
  });
  assert.equal(toolOutputView(failure).exitCode, 7);
  assert.equal(toolOutputView(failure).sections[0]?.text, failure.output);
  assert.equal(
    toolOutputView(tool({ ...failure, output: '命令退出 null\nterminated' })).exitCode,
    null,
  );
  assert.equal(
    toolOutputView(tool({ ...failure, output: 'unrecognized exit 7' })).exitCode,
    undefined,
  );
});

test('waiting, denied, failed and empty outputs have explicit states without inventing a receipt', () => {
  for (const status of [
    'running',
    'awaiting_permission',
    'succeeded',
    'failed',
    'denied',
    'canceled',
  ] as const) {
    const value = tool({ status, output: '', endedAt: null });
    const view = toolOutputView(value);
    assert.equal(view.sections.length, 0);
    assert.equal(view.exitCode, undefined);
    assert.ok(toolOutputMessage(value, view));
    if (status === 'running' || status === 'awaiting_permission')
      assert.match(toolOutputMessage(value, view) ?? '', /回执/u);
  }
});

test('unknown or malformed receipts and arbitrary JSON remain readable lossless text', () => {
  for (const output of [
    'not JSON <script>alert(1)</script>',
    '{"stdout":"truncated',
    'null',
    'false',
    '0',
  ]) {
    assert.equal(toolOutputView(tool({ output })).sections[0]?.text, output);
  }
  const value = tool({
    name: 'Read',
    inputSummary: '{"file_path":"/fixture/file","offset":4}',
    output: '{"data":{"lines":["one","two"]}}',
  });
  assert.match(toolInputView(value).parameters, /\n  "offset": 4/u);
  assert.match(toolOutputView(value).sections[0]?.text ?? '', /\n  "data":/u);
  const unknown = tool({
    output:
      '{"stdout":"ok","stderr":"","interrupted":false,"persistedOutputPath":"/fixture/output.txt","returnCodeInterpretation":"matched"}',
  });
  assert.match(toolOutputView(unknown).sections[2]?.text ?? '', /persistedOutputPath/u);
});

test('invalid receipt fields and non-string explanations stay visible in the text fallback', () => {
  const value = tool({
    output:
      '{"stdout":"ok","stderr":"","interrupted":"unknown","exitCode":"invalid","backgroundTaskId":12}',
  });
  const view = toolOutputView(value);
  assert.equal(view.exitCode, undefined);
  assert.equal(view.interrupted, undefined);
  assert.match(view.sections[2]?.text ?? '', /"exitCode": "invalid"/u);
  assert.match(view.sections[2]?.text ?? '', /"interrupted": "unknown"/u);
  const command = tool({
    name: 'run_command',
    output: '{"output":"ok","code":"invalid","truncated":false}',
  });
  assert.match(toolOutputView(command).sections[0]?.text ?? '', /"code": "invalid"/u);
  assert.match(
    toolInputView(
      tool({ inputSummary: '{"command":"printf fixture","description":{"hint":"preserved"}}' }),
    ).parameters,
    /preserved/u,
  );
});

test('executor and stored-preview truncation are reported without mislabeling partial output as empty', () => {
  const executor = tool({ name: 'run_command', output: '{"output":"","code":0,"truncated":true}' });
  assert.equal(toolOutputView(executor).truncated, true);
  assert.equal(toolOutputMessage(executor, toolOutputView(executor)), undefined);
  const stored = tool({ output: '{"stdout":"cut', outputTruncated: true, outputLength: 80000 });
  assert.equal(toolOutputView(stored).truncated, true);
  assert.equal(toolOutputView(stored).sections[0]?.text, stored.output);
});

test('Bash log actions and byte counts reflect the saved scope while historical output keeps its labels', () => {
  const receipt = JSON.stringify({ stdout: '中🙂', stderr: '', interrupted: false });
  const bytes = Buffer.byteLength('中🙂', 'utf8');
  const complete = tool({ output: receipt, bashLog: { status: 'complete', bytes } });
  assert.equal(bytes, 7);
  assert.match(toolOutputPresentation(complete).scope ?? '', /7 字节（UTF-8）/u);
  assert.equal(toolOutputPresentation(complete).actionLabel, '查看完整日志');
  const partial = tool({
    output: receipt,
    bashLog: { status: 'partial', bytes, sourceBytes: 100 },
  });
  const presentation = toolOutputPresentation(partial);
  assert.equal(presentation.actionLabel, '查看已保存日志');
  assert.equal(presentation.downloadLabel, '下载已保存内容');
  assert.equal(presentation.downloadName, 'bash-log-saved.txt');
  assert.match(presentation.scope ?? '', /已保存 7 字节 \/ 原日志 100 字节/u);
  for (const status of ['partial', 'unavailable', 'receipt-only'] as const) {
    const value = tool({ output: 'SDK error preview', bashLog: { status } });
    const view = toolOutputPresentation(value);
    assert.doesNotMatch(view.title + view.actionLabel + view.downloadLabel, /完整/u);
    assert.ok(view.scope);
    const markup = renderToStaticMarkup(
      createElement(ToolDetailBody, {
        tool: value,
        automaticallyApproved: false,
        onOutput() {},
      }),
    );
    assert.match(markup, /SDK 回执预览/u);
    assert.match(markup, /SDK error preview/u);
    assert.ok(markup.includes(view.actionLabel));
    assert.doesNotMatch(markup, /查看完整|下载完整/u);
  }
  const legacy = toolOutputPresentation(tool());
  assert.equal(legacy.title, '完整工具输出');
  assert.equal(legacy.actionLabel, '查看完整输出');
  assert.equal(legacy.downloadName, 'tool-output.txt');
});

const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].find((path) => path && existsSync(path));

test(
  'tool renderer keeps command and status discoverable, supports keyboard disclosure, live receipts, safe text and full-output actions in local fixtures',
  { skip: !browserPath, timeout: 45000 },
  async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const compiled = await build({
      absWorkingDir: root,
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ToolDetail, ToolDetailBody, toolCallSummary } from '@/features/inspector/tool-detail';
      import { uiI18n } from '@/i18n';
      const root = createRoot(document.getElementById('app'));
      window.changeFixtureLanguage = (locale) => uiI18n.changeLanguage(locale);
      window.outputClicks = 0;
      window.renderFixture = (tool, variant = 'default', body = false, outputAction = true) => {
        const Component = body ? ToolDetailBody : ToolDetail;
        root.render(<Component key={tool.id} tool={tool} variant={variant} automaticallyApproved onOutput={outputAction ? () => { window.outputClicks++; } : undefined} />);
      };
      window.summaryFixture = toolCallSummary;
    `,
      },
      tsconfig: `${root}/tsconfig.json`,
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      loader: { '.css': 'empty' },
    });
    const bundle = compiled.outputFiles[0]?.text;
    assert.ok(bundle);
    const utilities = await compile(readFileSync(`${root}/src/styles.css`, 'utf8'), {
      base: `${root}/src`,
      onDependency() {},
    });
    const candidates = [
      'features/inspector/shared.tsx',
      'components/ui/badge.tsx',
      'components/ui/button.tsx',
    ].flatMap((path) => readFileSync(`${root}/src/${path}`, 'utf8').split(/[\s"'`{}<>]/u));
    const styles = utilities.build(candidates);
    const server = createServer((req, res) => {
      if (req.url === '/bundle.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(bundle);
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${styles}</style></head><body style="padding:16px"><main id="app" style="max-width:860px"></main><script type="module" src="/bundle.js"></script></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const browser = await chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors: string[] = [];
      const external: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', async (route) => {
        if (new URL(route.request().url()).hostname !== '127.0.0.1') {
          external.push(route.request().url());
          await route.abort();
        } else await route.continue();
      });
      await page.goto(`http://127.0.0.1:${address.port}`);
      const render = async (
        value: ToolCall,
        variant = 'default',
        body = false,
        outputAction = true,
      ) => {
        await page.evaluate(
          ({ value, variant, body, outputAction }) =>
            Reflect.get(window, 'renderFixture')(value, variant, body, outputAction),
          { value, variant, body, outputAction },
        );
        await page.waitForFunction(
          (id) =>
            document.querySelector('[data-tool-id]')?.getAttribute('data-tool-id') === id ||
            (!document.querySelector('details') &&
              document.querySelector('.tool-detail__body') !== null),
          value.id,
        );
      };
      for (const status of [
        'running',
        'awaiting_permission',
        'succeeded',
        'failed',
        'denied',
        'canceled',
      ] as const) {
        await render(tool({ id: `contrast-${status}`, status }));
        const contrast = await page
          .locator('.tool-detail__status [data-slot="badge"]')
          .evaluate((element) => {
            const style = getComputedStyle(element);
            const [foreground = 0, background = 0] = [style.color, style.backgroundColor].map(
              (color) =>
                (color.match(/[\d.]+/gu) ?? []).slice(0, 3).reduce((sum, channel, index) => {
                  const value = Number(channel) / 255;
                  const linear =
                    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
                  return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
                }, 0),
            );
            return {
              ratio:
                (Math.max(foreground, background) + 0.05) /
                (Math.min(foreground, background) + 0.05),
              foreground: style.color,
              background: style.backgroundColor,
            };
          });
        assert.ok(contrast.ratio >= 4.5, `${status}: ${JSON.stringify(contrast)}`);
      }
      await render(tool());
      const summary = page.locator('.tool-detail__summary');
      assert.match(
        await summary.innerText(),
        /Bash[\s\S]*printf fixture[\s\S]*自动批准[\s\S]*成功/u,
      );
      assert.equal(await page.locator('details').getAttribute('open'), null);
      assert.equal(await page.getByLabel('命令', { exact: true }).isVisible(), false);
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.getByLabel('命令', { exact: true }).innerText(), 'printf fixture');
      assert.equal(await page.getByLabel('stdout', { exact: true }).innerText(), 'fixture\n');
      assert.match(await page.getByLabel('执行结果').innerText(), /退出码[\s\S]*未提供/u);
      await page.keyboard.press('Enter');
      assert.equal(await page.getByLabel('命令', { exact: true }).isVisible(), false);

      await render(
        tool({
          id: 'compact-receipt',
          output: JSON.stringify({
            stdout: 'result',
            stderr: '',
            interrupted: false,
            isImage: false,
            noOutputExpected: false,
          }),
        }),
      );
      await page.locator('.tool-detail__summary').click();
      assert.equal(await page.getByLabel('stderr', { exact: true }).count(), 0);
      assert.equal(await page.getByLabel('原始回执', { exact: true }).isVisible(), false);
      assert.equal(
        (await page.getByLabel('输出', { exact: true }).innerText()).includes('noOutputExpected'),
        false,
      );
      await page.locator('.tool-detail__raw > summary').click();
      assert.match(
        await page.getByLabel('原始回执', { exact: true }).innerText(),
        /noOutputExpected/u,
      );
      await render(
        tool({
          id: 'empty-receipt',
          output: JSON.stringify({
            stdout: '',
            stderr: '',
            interrupted: false,
            isImage: false,
            noOutputExpected: true,
          }),
        }),
      );
      await page.locator('.tool-detail__summary').click();
      assert.match(await page.getByLabel('输出', { exact: true }).innerText(), /（无输出）/u);
      assert.equal(await page.getByLabel('stdout', { exact: true }).count(), 0);
      assert.equal(await page.getByLabel('stderr', { exact: true }).count(), 0);

      await render(tool({ id: 'semicolon-command', command: semicolonCommand }), 'compact');
      await page.locator('.tool-detail__summary').click();
      const multiline = await page.getByLabel('命令', { exact: true }).evaluate((element) => {
        const range = document.createRange();
        const lineTops = [...element.querySelectorAll('.tool-detail__command-line')].map((line) => {
          range.selectNodeContents(line);
          return range.getClientRects()[0]?.top;
        });
        range.selectNodeContents(element);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        const selected = selection?.toString();
        selection?.removeAllRanges();
        return { lineTops, selected, source: element.textContent };
      });
      assert.equal(multiline.lineTops.length, 3);
      assert.equal(new Set(multiline.lineTops).size, 3);
      assert.equal(multiline.source, semicolonCommand);
      assert.equal(multiline.selected, semicolonCommand);

      const unsafe =
        '<img src="https://outside.invalid/track" onerror="window.pwned=true"><script>window.pwned=true</script>';
      const fullCommand = `printf '${unsafe}'\n${'x'.repeat(5000)}\ncommand-tail`;
      await render(
        tool({
          id: 'preserved',
          command: fullCommand,
          inputSummary: '{"command":"truncated',
          output: unsafe,
        }),
        'compact',
      );
      await page.locator('.tool-detail__summary').click();
      assert.equal(await page.getByLabel('命令', { exact: true }).textContent(), fullCommand);
      assert.equal(await page.getByLabel('原始回执', { exact: true }).textContent(), unsafe);
      assert.equal(await page.locator('#app img, #app script, #app iframe').count(), 0);
      assert.equal(await page.evaluate(() => Reflect.get(window, 'pwned')), undefined);
      assert.equal(await page.locator('pre[aria-label="参数"]').isVisible(), false);
      await page.getByText('原始参数', { exact: true }).click();
      assert.match(await page.getByLabel('参数', { exact: true }).first().innerText(), /历史截断/u);
      assert.equal(
        await page.locator('pre[aria-label="参数"]').textContent(),
        '{"command":"truncated',
      );

      await render(tool({ id: 'waiting', status: 'running', output: '', endedAt: null }));
      await page.locator('.tool-detail__summary').click();
      assert.match(await page.getByRole('status').innerText(), /等待工具返回真实回执/u);
      assert.equal(await page.getByLabel('stdout', { exact: true }).count(), 0);
      await render(
        tool({
          id: 'waiting',
          output: '{"stdout":"late reply","stderr":"warning","interrupted":true}',
        }),
      );
      await page.getByLabel('stdout', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('stdout', { exact: true }).textContent(), 'late reply');
      assert.equal(await page.getByLabel('stderr', { exact: true }).textContent(), 'warning');
      assert.match(await page.locator('.tool-detail__summary').innerText(), /已中断/u);
      assert.equal(await page.getByRole('status').count(), 0);

      const longText = 'recorded line\n'.repeat(150) + 'recorded-tail';
      await render(
        tool({
          id: 'long',
          name: 'mcp__atelier__run_command',
          output: JSON.stringify({ output: longText, code: 0, truncated: false }),
          outputTruncated: true,
          outputLength: 90000,
        }),
      );
      await page.locator('.tool-detail__summary').click();
      assert.equal(
        (await page.getByLabel('stdout / stderr（合并）', { exact: true }).textContent())?.includes(
          'recorded-tail',
        ),
        false,
      );
      await page.getByRole('button', { name: /展开已记录输出/u }).click();
      assert.equal(
        await page.getByLabel('stdout / stderr（合并）', { exact: true }).textContent(),
        longText,
      );
      await page.getByRole('button', { name: /查看完整输出/u }).click();
      assert.equal(await page.evaluate(() => Reflect.get(window, 'outputClicks')), 1);
      assert.match(await page.getByLabel('执行结果').innerText(), /退出码[\s\S]*0/u);

      await render(
        tool({ id: 'no-action', output: '{"stdout":"cut', outputTruncated: true }),
        'default',
        false,
        false,
      );
      await page.locator('.tool-detail__summary').click();
      assert.equal(await page.getByRole('button', { name: /查看完整输出/u }).count(), 0);
      assert.match(
        await page.getByLabel('输出', { exact: true }).innerText(),
        /当前未提供完整输出入口/u,
      );

      await render(
        tool({
          id: 'body-only',
          name: 'Read',
          inputSummary: '{"file_path":"/fixture/source.ts"}',
          output: 'plain result',
        }),
        'default',
        true,
      );
      await page.getByLabel('返回结果', { exact: true }).waitFor();
      assert.equal(await page.locator('details, summary').count(), 0);
      assert.equal(await page.getByText('自动批准', { exact: true }).count(), 1);
      assert.equal(
        await page.getByLabel('返回结果', { exact: true }).textContent(),
        'plain result',
      );

      for (const width of [1280, 1440, 1920]) {
        await page.setViewportSize({
          width,
          height: width === 1280 ? 800 : width === 1440 ? 900 : 1080,
        });
        for (const containerWidth of [320, 860]) {
          await page.locator('#app').evaluate((element, size) => {
            element.style.width = `${size}px`;
          }, containerWidth);
          const description = 'Inspect the workspace for matching files';
          const value = tool({
            id: `layout-${width}-${containerWidth}`,
            command: 'node ' + 'long-command-'.repeat(300),
            inputSummary: JSON.stringify({ description }),
            output: longText,
          });
          await render(value, 'compact');
          const compactSummary = page.locator('.tool-detail__summary');
          assert.equal(
            await compactSummary.getByText(description, { exact: true }).isVisible(),
            true,
          );
          await compactSummary.click();
          const commandPreview = await page
            .getByLabel('命令', { exact: true })
            .evaluate((element) => ({
              height: element.clientHeight,
              scrollHeight: element.scrollHeight,
            }));
          assert.ok(
            commandPreview.height <= 176 && commandPreview.height < commandPreview.scrollHeight,
          );
          const layout = await page.locator('details').evaluate((element) => ({
            width: element.clientWidth,
            scrollWidth: element.scrollWidth,
          }));
          assert.ok(
            layout.scrollWidth <= layout.width + 1,
            `overflow at ${width}/${containerWidth}: ${JSON.stringify(layout)}`,
          );
          assert.ok(
            ((await page.locator('.tool-detail__summary').boundingBox())?.height ?? 100) < 60,
          );
        }
      }
      await page.evaluate(() => Reflect.get(window, 'changeFixtureLanguage')('en'));
      await page.getByText('Succeeded', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Command', { exact: true }).isVisible(), true);
      assert.equal(
        await page.getByRole('region', { name: 'Output', exact: true }).isVisible(),
        true,
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
