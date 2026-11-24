/**
 * @file 验证多提交的分析、对话审查和手动编辑交互。
 * @implementation 在隔离 Chromium 和本机 HTTP 替身中验证双语、模型选择、分析进度与续跑，以及对话修改、撤销、详细编辑和批量分配。
 * @updated 2026-11-25T01:22:11+08:00
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));
const group = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Generated plan',
  body: '',
  unitIds: ['u1'],
};
const snapshot = {
  version: 'v1',
  branch: 'main',
  units: [
    {
      id: 'u1',
      path: 'sample.ts',
      layer: 'unstaged',
      kind: 'hunk',
      description: 'sample change',
      reason: null,
      dependsOn: [],
    },
  ],
  groups: [],
  modelCandidateIds: ['u1'],
  unassignedUnitIds: ['u1'],
  suggestionStatus: 'manual',
  suggestionReason: 'manual',
  coverage: { analyzed: 0, metadataOnly: 0, excluded: 0 },
};

test(
  'multi-commit models require explicit analysis, keep edits, and isolate canceled responses',
  { skip: !browserPath, timeout: 30_000 },
  async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const compiled = await build({
      absWorkingDir: root,
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
      import {GitMultiCommitDialog} from '@/features/git/git-multi-commit-dialog';
      import {useGitMultiCommitReview} from '@/features/git/hooks/use-git-multi-commit-review';
      import {uiI18n} from '@/i18n';
      const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
      function App() {
        const review = useGitMultiCommitReview('fixture-project','fixture-tree',()=>{});
        window.fixture = {review, language: value => uiI18n.changeLanguage(value)};
        return <><button onClick={review.start}>Open fixture</button><button onClick={review.startManual}>Open manual fixture</button><GitMultiCommitDialog review={review} restoreFocus={()=>{}}/><output id="groups">{JSON.stringify(review.groups)}</output></>;
      }
      createRoot(document.getElementById('app')).render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
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
    const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
    let analysisCount = 0;
    let savedPreferences: { model: string | null; effort: string | null } = {
      model: null,
      effort: null,
    };
    let failPreferenceSave = false;
    let holdPreferenceSave = false;
    let heldPreference:
      | { response: ServerResponse; value: { model: string | null; effort: string | null } }
      | undefined;
    let partialMode = false;
    let issueMode = false;
    let failureReason: string | undefined;
    let failFinal = false;
    let expireNext = false;
    let failRequests = 0;
    let held: ServerResponse | undefined;
    let hold = false;
    let progressReads = 0;
    let revealProgress = false;
    const server = createServer(async (req, res) => {
      const path = req.url ?? '/';
      if (path === '/bundle.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(bundle);
        return;
      }
      if (!path.startsWith('/api/')) {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>',
        );
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      let input = '';
      for await (const chunk of req) input += String(chunk);
      const body = input ? (JSON.parse(input) as Record<string, unknown>) : {};
      requests.push({ path, method: req.method ?? 'GET', body });
      if (path === '/api/bootstrap') {
        res.end(JSON.stringify({ csrfToken: 'fixture' }));
        return;
      }
      if (path === '/api/settings/git-multi-commit-preferences') {
        if (req.method === 'PATCH' && failPreferenceSave) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: { code: 'UNAVAILABLE' } }));
          return;
        }
        if (req.method === 'PATCH') {
          const value = {
            model: typeof body.model === 'string' ? body.model : null,
            effort: typeof body.effort === 'string' ? body.effort : null,
          };
          if (holdPreferenceSave) {
            holdPreferenceSave = false;
            heldPreference = { response: res, value };
            return;
          }
          savedPreferences = value;
        }
        res.end(JSON.stringify(savedPreferences));
        return;
      }
      if (path === '/api/config') {
        res.end(
          JSON.stringify({
            config: {
              gateway: 'http://127.0.0.1:1',
              model: 'workspace-default',
              magpieEnabled: false,
            },
            capabilities: { commands: true },
            connection: { available: true, message: 'fixture' },
          }),
        );
        return;
      }
      if (path.startsWith('/api/models')) {
        res.end(
          JSON.stringify({
            defaultModel: 'workspace-default',
            routesAvailable: true,
            models: [
              { id: 'other-model', displayName: 'Other model' },
              {
                id: 'fixed-model',
                displayName: 'Fixed model',
                effort: 'high',
                supportedEfforts: ['high'],
              },
              { id: 'magpie:disabled', source: 'magpie' },
            ],
            discovery: {
              routes: { status: 'ready', modelCount: 1 },
              codex: { status: 'ready', modelCount: 0 },
            },
          }),
        );
        return;
      }
      if (path.includes('/commit-analysis-progress?')) {
        progressReads++;
        res.end(
          JSON.stringify({
            progress: revealProgress
              ? {
                  stage: 'batch',
                  batchCount: 1,
                  completedBatchCount: 0,
                  analyzed: 0,
                  suggestedGroups: 0,
                }
              : null,
          }),
        );
        return;
      }
      if (path.endsWith('/commit-plan-revise')) {
        res.end(
          JSON.stringify({
            groups: [{ ...group, title: '对话修改后的标题' }],
            excludedUnitIds: [],
            note: '',
          }),
        );
        return;
      }
      if (path.endsWith('/commit-plan')) {
        if (failureReason && body.generate) {
          res.end(
            JSON.stringify({
              ...snapshot,
              suggestionStatus: 'partial',
              suggestionReason: failureReason,
              analysisModel: body.model ?? 'workspace-default',
              analysis: {
                id: body.analysisId,
                state: 'partial',
                reason: failureReason,
                batchCount: 7,
                completedBatchCount: 0,
                completedUnitIds: [],
                globalPass: 'pending',
                canResume: true,
                groupLimitReached: false,
                expiresAt: '2099-01-01T00:00:00.000Z',
              },
            }),
          );
          return;
        }
        if (issueMode) {
          const regular = Array.from({ length: 240 }, (_, index) => ({
            ...snapshot.units[0],
            id: `regular-${index}`,
            path: `src/file-${index}.ts`,
          }));
          const issues = [
            {
              ...snapshot.units[0],
              id: 'secret-1',
              path: 'tests/secret-one.ts',
              credential: { rule: 'literal', location: { kind: 'addition', line: 12 } },
            },
            {
              ...snapshot.units[0],
              id: 'secret-2',
              path: 'tests/secret-two.ts',
              credential: { rule: 'format', location: { kind: 'addition', line: 3 } },
            },
            {
              ...snapshot.units[0],
              id: 'conflict-1',
              path: 'conflict.ts',
              kind: 'unsupported',
              layer: 'conflict',
              reason: 'conflict',
            },
            { ...snapshot.units[0], id: 'pending-1', path: 'pending.ts' },
            {
              ...snapshot.units[0],
              id: 'pending-3',
              path: 'pending.ts',
              description: '@@ -21,3 +21,3 @@',
            },
            {
              ...snapshot.units[0],
              id: 'pending-2',
              path: 'atomic.ts',
              kind: 'atomic',
              reason: 'diffLimit',
            },
          ];
          const generated = body.generate === true;
          res.end(
            JSON.stringify({
              ...snapshot,
              units: [...regular, ...issues],
              groups: generated ? [{ ...group, unitIds: regular.map((unit) => unit.id) }] : [],
              modelCandidateIds: [
                ...regular.map((unit) => unit.id),
                'pending-1',
                'pending-2',
                'pending-3',
              ],
              unassignedUnitIds: generated
                ? issues.map((unit) => unit.id)
                : [...regular, ...issues].map((unit) => unit.id),
              suggestionStatus: generated ? 'ready' : 'manual',
              suggestionReason: generated ? null : 'manual',
            }),
          );
          return;
        }
        if (partialMode) {
          if (expireNext && body.resume) {
            expireNext = false;
            res.statusCode = 410;
            res.end(JSON.stringify({ error: { code: 'GIT_PLAN_ANALYSIS_EXPIRED' } }));
            return;
          }
          if (failRequests && (body.generate || body.resume)) {
            failRequests--;
            res.statusCode = 503;
            res.end(
              JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'fixture unavailable' } }),
            );
            return;
          }
          const units = [
            ...snapshot.units,
            { ...snapshot.units[0], id: 'u2', path: 'second.ts' },
            {
              ...snapshot.units[0],
              id: 'u3',
              path: 'blocked.ts',
              credential: { rule: 'format', location: { kind: 'addition', line: 1 } },
            },
          ];
          const nextGroup = {
            ...group,
            id: '22222222-2222-4222-8222-222222222222',
            title: 'Second',
            unitIds: ['u2'],
          };
          const resumed = body.resume === true && body.generate === true;
          const hasAnalysis = Boolean(body.generate || body.resume);
          const complete = resumed && !failFinal;
          const reason = complete ? null : resumed ? 'http' : 'timeout';
          const analysis = hasAnalysis
            ? {
                id: body.analysisId,
                state: complete ? 'complete' : 'partial',
                reason,
                batchCount: 2,
                completedBatchCount: resumed ? 2 : 1,
                completedUnitIds: resumed ? ['u1', 'u2'] : ['u1'],
                globalPass: complete ? 'completed' : 'pending',
                canResume: !complete,
                groupLimitReached: false,
                expiresAt: '2099-01-01T00:00:00.000Z',
              }
            : undefined;
          res.end(
            JSON.stringify({
              ...snapshot,
              units,
              modelCandidateIds: ['u1', 'u2'],
              ...(analysis ? { analysis } : {}),
              groups: hasAnalysis ? (resumed ? [group, nextGroup] : [group]) : [],
              unassignedUnitIds: hasAnalysis
                ? resumed
                  ? ['u3']
                  : ['u2', 'u3']
                : ['u1', 'u2', 'u3'],
              suggestionStatus: hasAnalysis ? (complete ? 'ready' : 'partial') : 'manual',
              suggestionReason: hasAnalysis ? reason : 'manual',
              coverage: {
                analyzed: hasAnalysis ? (resumed ? 2 : 1) : 0,
                metadataOnly: 0,
                excluded: 0,
              },
            }),
          );
          return;
        }
        if (!body.generate) {
          res.end(JSON.stringify(snapshot));
          return;
        }
        analysisCount++;
        if (hold) {
          held = res;
          return;
        }
        res.end(
          JSON.stringify(
            analysisCount === 1
              ? {
                  ...snapshot,
                  suggestionReason: 'timeout',
                  analysisModel: body.model ?? 'workspace-default',
                }
              : {
                  ...snapshot,
                  analysisModel: body.model ?? 'workspace-default',
                  groups: [group],
                  unassignedUnitIds: [],
                  suggestionStatus: 'ready',
                  suggestionReason: null,
                  coverage: { analyzed: 1, metadataOnly: 0, excluded: 0 },
                },
          ),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
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
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(3000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole('button', { name: 'Open fixture' }).click();
      const analyze = page.getByRole('button', { name: '让 AI 规划分组', exact: true });
      await analyze.waitFor();
      await page.getByText('尚未开始 AI 规划', { exact: true }).waitFor({ timeout: 1000 });
      await page
        .getByRole('textbox', { name: '补充提交要求（可选）', exact: true })
        .fill('代码和文档分开', { timeout: 1500 });
      assert.equal(await page.locator('.git-multi-commit-unit').count(), 0);
      assert.equal(await page.getByRole('button', { name: '核对提交预览' }).count(), 0);
      assert.equal(analysisCount, 0);
      assert.equal(progressReads, 0);
      assert.deepEqual(
        requests
          .filter((request) => request.path.endsWith('/commit-plan'))
          .map((request) => request.body),
        [{ locale: 'zh-CN', generate: false }],
      );
      const picker = page.getByRole('combobox', { name: '选择模型', exact: true });
      assert.match((await picker.textContent()) ?? '', /workspace-default/);
      await picker.click();
      assert.equal(
        await page.getByRole('option', { name: 'magpie:disabled', exact: true }).isDisabled(),
        true,
      );
      holdPreferenceSave = true;
      const firstPreferenceRequest = page.waitForRequest(
        (request) =>
          request.url().endsWith('/api/settings/git-multi-commit-preferences') &&
          request.method() === 'PATCH',
      );
      await page.getByRole('option', { name: /Other model/ }).click();
      await firstPreferenceRequest;
      await page.getByRole('combobox', { name: '选择推理深度' }).click();
      await page.getByRole('option', { name: '高', exact: true }).click();
      await page.waitForFunction("window.fixture.review.effort === 'high'");
      assert.equal(await analyze.isDisabled(), true);
      assert.ok(heldPreference);
      savedPreferences = heldPreference.value;
      heldPreference.response.end(JSON.stringify(savedPreferences));
      heldPreference = undefined;
      await page.waitForFunction('window.fixture.review.preferencesSaving === false');
      assert.deepEqual(savedPreferences, { model: 'other-model', effort: 'high' });
      assert.equal(analysisCount, 0);
      await analyze.click();
      await page
        .getByText('AI 分析超时，未生成完整计划；可重试或手动分组。', { exact: true })
        .waitFor();
      assert.equal(
        requests.find((request) => request.body.generate === true)?.body.model,
        'other-model',
      );
      assert.equal(requests.find((request) => request.body.generate === true)?.body.version, 'v1');
      assert.equal(requests.find((request) => request.body.generate === true)?.body.effort, 'high');
      assert.equal(
        requests.find((request) => request.body.generate === true)?.body.instruction,
        '代码和文档分开',
      );
      assert.deepEqual(savedPreferences, { model: 'other-model', effort: 'high' });
      hold = true;
      await page.getByRole('button', { name: '重新开始 AI 规划', exact: true }).click();
      await page.getByText('正在分析工作区改动…', { exact: true }).first().waitFor();
      revealProgress = true;
      await page.getByText('正在分析第 1 / 1 批', { exact: true }).waitFor();
      assert.equal(
        await page.getByRole('progressbar', { name: '已完成的分析批次' }).getAttribute('value'),
        '0',
      );
      assert.ok(progressReads > 0);
      assert.equal(analysisCount, 2, 'reading progress never starts another inference');
      const lastAnalysis = requests.filter(({ body }) => body.generate === true).at(-1);
      const lookupProgress = requests
        .filter(({ path }) => path.includes('/commit-analysis-progress?'))
        .at(-1);
      assert.ok(lookupProgress);
      const progressParams = new URL(lookupProgress.path, 'http://127.0.0.1').searchParams;
      assert.equal(lookupProgress.method, 'GET');
      assert.equal(progressParams.get('analysisId'), lastAnalysis?.body.analysisId);
      assert.equal(progressParams.get('version'), 'v1');
      assert.equal(
        await page
          .getByText('AI 分析超时，未生成完整计划；可重试或手动分组。', { exact: true })
          .count(),
        0,
      );
      assert.equal(await picker.isDisabled(), true);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Open fixture' }).click();
      await analyze.waitFor();
      assert.match((await picker.textContent()) ?? '', /other-model|Other model/);
      assert.match(
        (await page.getByRole('combobox', { name: '选择推理深度' }).textContent()) ?? '',
        /高/,
      );
      const progressAtClose = progressReads;
      held?.end(
        JSON.stringify({
          ...snapshot,
          groups: [group],
          unassignedUnitIds: [],
          suggestionStatus: 'ready',
        }),
      );
      hold = false;
      await page.waitForFunction('window.fixture.review.preparing === false');
      assert.equal(await page.locator('#groups').textContent(), '[]');
      await page.waitForTimeout(1100); // One poll interval must pass without another progress request.
      assert.equal(progressReads, progressAtClose);
      await picker.click();
      await page.getByRole('option', { name: '手动输入 ID…', exact: true }).click();
      const manual = page.getByRole('textbox', { name: '模型 ID', exact: true });
      await manual.fill('magpie:disabled');
      assert.equal(
        await page.getByRole('button', { name: '使用此模型', exact: true }).isDisabled(),
        true,
      );
      assert.deepEqual(savedPreferences, { model: 'other-model', effort: 'high' });
      await manual.fill('custom-model');
      await page.getByRole('button', { name: '使用此模型', exact: true }).click();
      await analyze.click();
      await page
        .getByRole('textbox', { name: '告诉 AI 怎么改', exact: true })
        .fill('改写第一条标题');
      await page.getByRole('button', { name: '发送修改要求', exact: true }).click();
      await page.getByRole('button', { name: '撤销上次 AI 修改', exact: true }).waitFor();
      assert.match(await page.locator('#groups').innerText(), /对话修改后的标题/);
      assert.equal(
        requests.find((request) => request.path.endsWith('/commit-plan-revise'))?.body.version,
        'v1',
      );
      await page.getByRole('button', { name: '撤销上次 AI 修改', exact: true }).click();
      assert.match(await page.locator('#groups').innerText(), /Generated plan/);
      await page.getByRole('button', { name: '展开详细编辑与差异', exact: true }).click();
      const subject = page.getByRole('textbox', { name: '提交标题', exact: true });
      await subject.waitFor();
      await subject.fill('Keep my edited plan');
      assert.equal(await subject.inputValue(), 'Keep my edited plan');
      assert.equal(await analyze.count(), 0);
      assert.equal(await picker.count(), 0);
      await page.getByText('上次 AI 分析模型：custom-model。', { exact: false }).waitFor();
      await page.evaluate("window.fixture.language('en')");
      await page.getByText('AI groups are ready for review', { exact: true }).waitFor();
      assert.equal(
        requests.filter((request) => request.path === '/api/config' && request.method !== 'GET')
          .length,
        0,
      );
      assert.equal(
        requests.filter((request) => request.body.generate === true).at(-1)?.body.model,
        'custom-model',
      );
      assert.equal(
        requests.filter((request) => request.body.generate === true).at(-1)?.body.effort,
        undefined,
      );
      await page.keyboard.press('Escape');
      partialMode = true;
      await page.getByRole('button', { name: 'Open fixture' }).click();
      await page.getByRole('button', { name: 'Plan groups with AI', exact: true }).click();
      const continueButton = page.getByRole('button', {
        name: 'Continue analyzing remaining changes',
        exact: true,
      });
      await continueButton.waitFor();
      const analyzedCount = await page
        .getByText('Analyzed 1 of 2 eligible changes. Metadata only: 0.', { exact: true })
        .isVisible();
      assert.equal(analyzedCount, true);
      await page.getByRole('button', { name: 'Open detailed review', exact: true }).click();
      await page.getByRole('radio', { name: 'Needs a decision', exact: true }).check();
      const blockedRow = page.locator('.git-multi-commit-unit').filter({ hasText: 'blocked.ts' });
      assert.match(await blockedRow.innerText(), /Added line 1.*known credential format/);
      await blockedRow.getByRole('combobox').click();
      await page.getByRole('option', { name: 'Keep uncommitted', exact: true }).click();
      const editableTitle = page.getByRole('textbox', { name: 'Commit subject', exact: true });
      await editableTitle.fill('Keep edited title');
      const footerReasons = page.locator('.git-multi-commit-blocking');
      assert.match((await footerReasons.textContent()) ?? '', /1 change has not been analyzed/);
      assert.equal(
        await page.getByRole('button', { name: 'Review commit previews' }).isDisabled(),
        true,
      );
      await footerReasons.getByRole('button', { name: 'Not analyzed', exact: true }).click();
      assert.deepEqual(await page.locator('.git-multi-commit-unit code').allTextContents(), [
        'second.ts',
      ]);
      assert.equal(
        await page.getByRole('radio', { name: 'Not analyzed', exact: true }).isChecked(),
        true,
      );
      const previousAnalysis = requests.filter((request) => request.body.generate === true).at(-1)
        ?.body.analysisId;
      failFinal = true;
      await continueButton.click();
      await page.waitForFunction(
        () => JSON.parse(document.querySelector('#groups')?.textContent ?? '[]').length === 2,
      );
      const groups = JSON.parse((await page.locator('#groups').textContent()) ?? '[]') as Array<{
        title: string;
        unitIds: string[];
      }>;
      assert.equal(groups[0]?.title, 'Keep edited title');
      assert.deepEqual(groups[1]?.unitIds, ['u2']);
      const retryFinal = page.getByRole('button', { name: 'Retry final grouping', exact: true });
      await retryFinal.waitFor();
      assert.equal(await page.getByText(/All batches were analyzed/).isVisible(), true);
      assert.equal(await page.getByRole('radio', { name: 'Not analyzed', exact: true }).count(), 0);
      assert.equal(
        await page.getByRole('button', { name: 'Review commit previews' }).isEnabled(),
        true,
      );
      assert.equal(await page.getByRole('button', { name: 'Create commits' }).isDisabled(), true);
      let resumedRequest = requests
        .filter((request) => request.body.generate === true)
        .at(-1)?.body;
      assert.equal(resumedRequest?.analysisId, previousAnalysis);
      assert.equal(resumedRequest?.resume, true);
      assert.equal(resumedRequest?.model, 'custom-model');
      // Final grouping retry stays bound to the language the initial attempt used.
      await page.evaluate("window.fixture.language('zh-CN')");
      failFinal = false;
      await page.getByRole('button', { name: '重试最终分组整理', exact: true }).click();
      await page.getByText('AI 分组已就绪', { exact: true }).waitFor();
      resumedRequest = requests.filter((request) => request.body.generate === true).at(-1)?.body;
      assert.equal(resumedRequest?.locale, 'en');
      assert.equal(resumedRequest?.analysisId, previousAnalysis);
      assert.deepEqual(JSON.parse((await page.locator('#groups').textContent()) ?? '[]'), groups);
      assert.deepEqual(await page.evaluate('window.fixture.review.excludedUnitIds'), ['u3']);
      await page.evaluate("window.fixture.language('en')");
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Open fixture' }).click();
      failRequests = 2;
      await page.getByRole('button', { name: 'Plan groups with AI', exact: true }).click();
      const checkButton = page.getByRole('button', { name: 'Check analysis status', exact: true });
      await checkButton.waitFor();
      const failedId = requests.filter((request) => request.body.generate === true).at(-1)
        ?.body.analysisId;
      const generationCount = requests.filter((request) => request.body.generate === true).length;
      await checkButton.click();
      await page
        .getByRole('button', { name: 'Continue analyzing remaining changes', exact: true })
        .waitFor();
      const lookup = requests.filter((request) => request.body.resume === true).at(-1)?.body;
      assert.equal(lookup?.analysisId, failedId);
      assert.equal(lookup?.generate, false);
      assert.equal(
        requests.filter((request) => request.body.generate === true).length,
        generationCount,
      );
      await page.getByRole('button', { name: 'Open detailed review', exact: true }).click();
      const preserved = page.getByRole('textbox', { name: 'Commit subject', exact: true });
      await preserved.fill('Edited before expiry');
      expireNext = true;
      await continueButton.click();
      await page.getByText(/This analysis expired/).waitFor();
      assert.equal(await preserved.inputValue(), 'Edited before expiry');
      await page.getByRole('button', { name: 'Start AI planning again', exact: true }).click();
      await continueButton.waitFor();
      assert.notEqual(
        requests.filter((request) => request.body.generate === true).at(-1)?.body.analysisId,
        failedId,
      );
      assert.equal(await preserved.inputValue(), 'Edited before expiry');
      await page.keyboard.press('Escape');
      partialMode = false;
      issueMode = true;
      await page.getByRole('button', { name: 'Open fixture' }).click();
      await page.getByText('AI planning has not started', { exact: true }).waitFor();
      assert.match(await page.getByRole('dialog').innerText(), /Changes in this worktree: 246/);
      assert.equal(await page.locator('.git-multi-commit-unit').count(), 0);
      await page.getByRole('button', { name: 'Plan groups with AI', exact: true }).click();
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('#groups')?.textContent ?? '[]')[0]?.unitIds.length ===
          240,
      );
      await page.getByRole('button', { name: 'Open detailed review', exact: true }).click();
      assert.equal(await page.getByRole('radio', { name: 'Group changes' }).isChecked(), true);
      await page.getByRole('radio', { name: 'Needs a decision' }).check();
      await page
        .getByRole('button', { name: 'Retain pending items in Possible credentials (2)' })
        .waitFor();
      assert.equal(
        await page.getByRole('radio', { name: 'Needs a decision', exact: true }).isChecked(),
        true,
      );
      const visibleIssues = await page
        .locator('.git-multi-commit-unit:visible code')
        .allTextContents();
      assert.equal(await page.getByRole('button', { name: /Read \/ size \/ budget/ }).count(), 0);
      assert.match(
        await page.getByRole('button', { name: /^Ungrouped by the model/ }).innerText(),
        /3 changes/,
      );
      assert.deepEqual(visibleIssues.sort(), [
        'atomic.ts',
        'conflict.ts',
        'pending.ts',
        'pending.ts',
        'tests/secret-one.ts',
        'tests/secret-two.ts',
      ]);
      const fileSelection = page.getByRole('checkbox', {
        name: 'Select changes in pending.ts',
        exact: true,
      });
      await fileSelection.waitFor({ timeout: 1500 });
      await page
        .getByRole('button', { name: 'Retain pending items in Possible credentials (2)' })
        .click();
      const retained = (await page.evaluate('window.fixture.review.excludedUnitIds')) as string[];
      assert.deepEqual(retained.sort(), ['secret-1', 'secret-2']);
      assert.deepEqual(
        (await page.locator('.git-multi-commit-unit:visible code').allTextContents()).sort(),
        ['atomic.ts', 'conflict.ts', 'pending.ts', 'pending.ts'],
      );
      const remainingGroups = JSON.parse(
        (await page.locator('#groups').textContent()) ?? '[]',
      ) as Array<{ unitIds: string[] }>;
      assert.equal(remainingGroups[0]?.unitIds.length, 240);
      await page.getByRole('radio', { name: 'Retained', exact: true }).check();
      assert.deepEqual(
        (await page.locator('.git-multi-commit-unit:visible code').allTextContents()).sort(),
        ['tests/secret-one.ts', 'tests/secret-two.ts'],
      );
      const retainedRow = page
        .locator('.git-multi-commit-unit')
        .filter({ hasText: 'tests/secret-one.ts' });
      await retainedRow.getByRole('combobox').click();
      await page.getByRole('option', { name: 'Unassigned', exact: true }).click();
      assert.deepEqual(await page.evaluate('window.fixture.review.excludedUnitIds'), ['secret-2']);
      await page.getByRole('radio', { name: 'Needs a decision', exact: true }).check();
      assert.equal(
        await page
          .locator('.git-multi-commit-unit:visible code')
          .filter({ hasText: 'tests/secret-one.ts' })
          .count(),
        1,
      );
      const modelSelection = page.getByRole('checkbox', {
        name: 'Select Ungrouped by the model',
        exact: true,
      });
      const credentialSelection = page.getByRole('checkbox', {
        name: 'Select Possible credentials',
        exact: true,
      });
      const destination = page.getByRole('combobox', { name: 'Batch destination', exact: true });
      const applyBatch = page.getByRole('button', { name: 'Apply to selection', exact: true });
      await fileSelection.check();
      assert.equal(
        await modelSelection.evaluate(
          (input) => input instanceof HTMLInputElement && input.indeterminate,
        ),
        true,
      );
      await credentialSelection.check();
      await destination.click();
      assert.equal(
        await page
          .getByRole('option', { name: 'Commit 1: Generated plan', exact: true })
          .isDisabled(),
        true,
      );
      await page.keyboard.press('Escape');
      await credentialSelection.uncheck();
      await destination.click();
      await page.getByRole('option', { name: 'Commit 1: Generated plan', exact: true }).click();
      assert.equal(await page.locator('#groups').textContent(), JSON.stringify(remainingGroups));
      await applyBatch.click();
      const assigned = JSON.parse((await page.locator('#groups').textContent()) ?? '[]') as Array<{
        unitIds: string[];
      }>;
      assert.deepEqual(assigned[0]?.unitIds.slice(-2), ['pending-1', 'pending-3']);
      await modelSelection.check();
      await credentialSelection.check();
      await page.getByRole('checkbox', { name: 'Select Conflicts', exact: true }).check();
      await destination.click();
      await page.getByRole('option', { name: 'Keep uncommitted', exact: true }).click();
      await applyBatch.click();
      const newlyRetained = (await page.evaluate(
        'window.fixture.review.excludedUnitIds',
      )) as string[];
      assert.deepEqual(newlyRetained.sort(), ['conflict-1', 'pending-2', 'secret-1', 'secret-2']);
      assert.equal(
        await page.getByRole('button', { name: 'Review commit previews' }).isDisabled(),
        true,
      );
      assert.match(
        (await page.locator('.git-multi-commit-blocking').textContent()) ?? '',
        /Resolve the conflict/,
      );
      await page.keyboard.press('Escape');
      issueMode = false;
      const inferenceBeforeManual = requests.filter(({ body }) => body.generate === true).length;
      await page.getByRole('button', { name: 'Open manual fixture' }).click();
      const manualPlan = page.getByRole('dialog', { name: 'Manual commit', exact: true });
      await manualPlan
        .getByRole('textbox', { name: 'Commit subject', exact: true })
        .fill('Manual title');
      await manualPlan.getByRole('radio', { name: 'Needs a decision' }).check();
      await manualPlan
        .locator('.git-multi-commit-unit')
        .filter({ hasText: 'sample.ts' })
        .getByRole('checkbox')
        .check();
      await manualPlan.getByRole('combobox', { name: 'Batch destination', exact: true }).click();
      await page.getByRole('option', { name: 'Commit 1: Manual title', exact: true }).click();
      await manualPlan.getByRole('button', { name: 'Apply to selection' }).click();
      assert.equal(
        await manualPlan.getByRole('button', { name: 'Review commit previews' }).isEnabled(),
        true,
      );
      assert.equal(
        await manualPlan.getByRole('button', { name: 'Plan groups with AI' }).count(),
        0,
      );
      assert.equal(
        requests.filter(({ body }) => body.generate === true).length,
        inferenceBeforeManual,
      );
      await page.keyboard.press('Escape');
      for (const [reason, text] of [
        ['invalid-response', 'The model returned commit groups with invalid fields.'],
        [
          'invalid-envelope',
          'The gateway returned an unrecognized message format or completion status.',
        ],
        ['invalid-json', 'The model did not return a complete JSON plan.'],
        ['truncated', 'The model output was cut off at its length limit.'],
        ['response-too-large', 'The model response exceeded the processing limit.'],
        ['unknown-id', 'The model returned a change identifier outside this batch.'],
        ['duplicate-id', 'The model assigned a change more than once.'],
        ['missing-id', 'The model omitted some changes from this batch.'],
      ] as const) {
        failureReason = reason;
        await page.getByRole('button', { name: 'Open fixture' }).click();
        await page.getByRole('button', { name: 'Plan groups with AI', exact: true }).click();
        await page.getByText(text, { exact: false }).waitFor();
        if (reason === 'missing-id') {
          const first = requests.filter((request) => request.body.generate === true).at(-1)
            ?.body.analysisId;
          const retryPicker = page.getByRole('combobox', {
            name: 'Choose model',
            exact: true,
          });
          await retryPicker.click();
          await page.getByRole('option', { name: /Other model/ }).click();
          await page.getByRole('button', { name: 'Start AI planning again', exact: true }).click();
          await page.getByText(text, { exact: false }).waitFor();
          const retry = requests.filter((request) => request.body.generate === true).at(-1)?.body;
          assert.equal(retry?.model, 'other-model');
          assert.notEqual(retry?.analysisId, first);
        }
        await page.keyboard.press('Escape');
      }
      await page.getByRole('button', { name: 'Open fixture' }).click();
      await page.getByRole('combobox', { name: 'Choose reasoning effort' }).click();
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith('/api/settings/git-multi-commit-preferences') &&
            response.request().method() === 'PATCH',
        ),
        page.getByRole('option', { name: 'Medium', exact: true }).click(),
      ]);
      assert.deepEqual(savedPreferences, { model: 'other-model', effort: 'medium' });
      await page.reload();
      await page.getByRole('button', { name: 'Open fixture' }).click();
      await page.getByRole('button', { name: '让 AI 规划分组', exact: true }).waitFor();
      assert.match(
        (await page.getByRole('combobox', { name: '选择模型', exact: true }).textContent()) ?? '',
        /other-model|Other model/,
      );
      assert.match(
        (await page.getByRole('combobox', { name: '选择推理深度' }).textContent()) ?? '',
        /中/,
      );
      await page.getByRole('combobox', { name: '选择模型', exact: true }).click();
      await page.getByRole('option', { name: /Fixed model/ }).click();
      const fixed = page.getByRole('combobox', { name: '选择推理深度' });
      assert.equal(await fixed.isDisabled(), true);
      assert.match((await fixed.textContent()) ?? '', /高/);
      await page.getByRole('button', { name: '让 AI 规划分组', exact: true }).click();
      await page.getByText('模型遗漏了本批次的一些变更，请重试。', { exact: true }).waitFor();
      const fixedRequest = requests
        .filter((request) => request.body.generate === true)
        .at(-1)?.body;
      assert.equal(fixedRequest?.model, 'fixed-model');
      assert.equal(fixedRequest?.effort, undefined);
      failPreferenceSave = true;
      await page.getByRole('combobox', { name: '选择模型', exact: true }).click();
      await page.getByRole('option', { name: /Other model/ }).click();
      const saveError = page.getByRole('alert').filter({ hasText: '当前选择尚未保存' });
      await saveError.waitFor();
      assert.match(
        (await page.getByRole('combobox', { name: '选择模型', exact: true }).textContent()) ?? '',
        /other-model|Other model/,
      );
      failPreferenceSave = false;
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith('/api/settings/git-multi-commit-preferences') &&
            response.request().method() === 'PATCH' &&
            response.ok(),
        ),
        saveError.getByRole('button', { name: '重试' }).click(),
      ]);
      assert.deepEqual(savedPreferences, { model: 'other-model', effort: null });
      assert.deepEqual(errors, []);
    } finally {
      heldPreference?.response.end();
      held?.end();
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
