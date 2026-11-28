/**
 * @file Regressions for task plan and delivery grading.
 * @implementation Exercises misleading acceptance wording, missing browser observations, scoped revision and legitimate arithmetic.
 * @updated 2026-11-28T19:14:00+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeDelivery, gradePlan } from '../scripts/task-plan-eval-cases.mjs';

test('an HTML plan names checks for all required scenarios before delivery', () => {
  const plan = {
    kind: 'plan' as const,
    reply: '',
    steps: [
      '读取 source/event.md 并生成单文件离线 handout.html，配置 375px、1440px 和 A4。',
      '检查桌面 1440px，然后交付 HTML 原件。',
    ],
  };
  assert.equal(gradePlan('html', plan).verifyAndDeliver, false);
  plan.steps[1] = '打开浏览器检查 375px、1440px 布局和 A4 打印，然后交付 HTML 原件。';
  assert.equal(gradePlan('html', plan).verifyAndDeliver, true);
  plan.steps[1] = '检查 375px 和 1440px 的布局。';
  plan.steps.push('设为 A4 纸张尺寸并执行打印预览，核对分页。', '交付 HTML 原件。');
  assert.equal(gradePlan('html', plan).verifyAndDeliver, true);
});

test('an HTML file without browser evidence cannot pass render checks', () => {
  const files = [{ path: 'handout.html', content: '<h1>Example</h1>' }];
  const grade = gradeDelivery('html', { reply: '', files }, { 'handout.html': '<h1>Example</h1>' });
  assert.equal(grade.requestedFilesOnly, true);
  assert.equal(grade.singleA4, false);
});

test('a cancelled PDF deliverable fails even if another clause says only Markdown', () => {
  const plan = {
    kind: 'plan' as const,
    reply: '',
    steps: ['核对 /status 和 /export。', '只保留 handoff.md，然后生成 PDF。'],
  };
  assert.equal(gradePlan('revision', plan).removePdf, false);
  plan.steps[1] = '只保留 handoff.md，不生成 PDF。';
  assert.equal(gradePlan('revision', plan).removePdf, true);
});

test('arithmetic expressions receive credit for their stated results', () => {
  const checks = gradeDelivery(
    'calculation',
    {
      reply:
        '来源：rules/pricing.md、data/products.csv。\n分子：16 + 18 + 20 = 54\n分母：3\n平均价：54 / 3 = 18',
      files: [],
    },
    {},
  );
  assert.ok(Object.values(checks).every(Boolean));
});

test('a supported diagnosis can cite a named actual value and a minimum in separate clauses', () => {
  const answer =
    'src/refresh.ts 要求 batchSize 大于等于 1。reports/refresh.log 的 RFX-731 记录 actual=0。';
  assert.equal(gradeDelivery('readonly', { reply: answer, files: [] }, {}).evidence, true);
});

test('a Markdown heading can bind status and evidence from its own section', () => {
  const path = 'handoff.md';
  const content = '### /status\n状态：已走验收，编号 GREEN-712\n### /export\n状态：待核实';
  const grade = gradeDelivery(
    'revision',
    { reply: '', files: [{ path, content }] },
    { [path]: content },
  );
  assert.equal(grade.knownPath, true);
  assert.equal(grade.unknownPath, true);
  assert.equal(grade.groundedDate, true);
  const withDate = `${content}\n\n生成时间：2023-10-27`;
  assert.equal(
    gradeDelivery(
      'revision',
      { reply: '', files: [{ path, content: withDate }] },
      { [path]: withDate },
    ).groundedDate,
    false,
  );
});
