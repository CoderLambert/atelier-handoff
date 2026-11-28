/**
 * @file Regressions for task plan and delivery grading.
 * @implementation Exercises misleading acceptance wording, missing browser observations, scoped revision and legitimate arithmetic.
 * @updated 2026-11-28T19:14:00+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containsHtmlFacts, gradeDelivery, gradePlan } from '../scripts/task-plan-eval-cases.mjs';

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

test('a conflicting Markdown status fails even with a correct release-note summary', () => {
  const path = 'handoff.md';
  const content =
    '| /status | 待核实 | 文件不存在 |\n- /status 已走验收，编号 GREEN-712。\n- /export 尚未核对。';
  const grade = gradeDelivery(
    'revision',
    { reply: '', files: [{ path, content }] },
    { [path]: content },
  );
  assert.equal(grade.knownPath, false);
  assert.equal(grade.unknownPath, true);
});

test('HTML facts remain visible when a heading wraps or time uses a nonbreaking space', () => {
  const text = 'Cedar\nRepair Day\n09:30\u00a0UTC\nARC-604\nARC-718\nARC-832';
  assert.equal(containsHtmlFacts(text), true);
  assert.equal(containsHtmlFacts(text.replace('ARC-832', 'ARC-833')), false);
});

test('an HTML plan can describe offline layout without using the word offline', () => {
  const plan = {
    kind: 'plan' as const,
    reply: '',
    steps: [
      '读取 source/event.md。制作为无需外部资源的单文件 handout.html。',
      '检查 375px、1440px 布局和单页 A4 打印。',
      '交付 HTML 原件。',
    ],
  };
  assert.equal(gradePlan('html', plan).singleOfflineHtml, true);
});

test('follow-up verification in a separate table column does not contradict the recorded state', () => {
  const path = 'handoff.md';
  const content = [
    '| 路径 | 记录状态 | 后续核实 |',
    '| --- | --- | --- |',
    '| `/status` | 已走验收 | GREEN-712；待核实当前可用性。 |',
    '| `/export` | 尚未核对 | 待核实 |',
  ].join('\n');
  const grade = gradeDelivery(
    'revision',
    { reply: '', files: [{ path, content }] },
    { [path]: content },
  );
  assert.equal(grade.knownPath, true);
  assert.equal(grade.unknownPath, true);
});

test('a revision plan can verify paths by locating evidence in the release record', () => {
  const checks = gradePlan('revision', {
    kind: 'plan',
    reply: '',
    steps: [
      '读取 release/notes.md，查找 /status 和 /export 的证据。',
      '发布 handoff.md，保留已确认和待核实的状态。',
    ],
  });
  assert.equal(checks.verifyPaths, true);
});
