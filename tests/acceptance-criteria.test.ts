/**
 * @file Exercises the user-text boundary for run delivery checks.
 * @implementation Checks explicit deliverables, required passages, exact and computed replies, and HTML requirements against ambiguous or quoted requests.
 * @updated 2026-11-28T22:19:17+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAcceptanceCriteria } from '../server/modules/runs/acceptance-criteria.js';

const none = { replyOnly: false, artifacts: [] };

test('conversion and explicit handoff agree on one HTML output', () => {
  const text =
    '把 source/event.md 做成可离线打开的单文件 handout.html。保留活动标题、开放时间和三个工位编号。要求实际检查 375px、1440px 布局和单页 A4 打印，再交付 HTML 原件。只交付该 HTML 文件。';
  assert.deepEqual(readAcceptanceCriteria(text), {
    replyOnly: false,
    artifacts: ['handout.html'],
    onlyArtifacts: true,
    html: { name: 'handout.html', widths: [375, 1440], a4: true, singlePage: true, offline: true },
  });
  assert.deepEqual(
    readAcceptanceCriteria(
      'Deliver handout.html. Check the layout at 375px and 1440px and a single-page A4 print.',
    ),
    {
      replyOnly: false,
      artifacts: ['handout.html'],
      html: { name: 'handout.html', widths: [375, 1440], a4: true, singlePage: true },
    },
  );
});

test('directly named offline output does not require inferred viewport or print checks', () => {
  assert.deepEqual(
    readAcceptanceCriteria('Deliver an offline single-file HTML file named handout.html.'),
    {
      replyOnly: false,
      artifacts: ['handout.html'],
      html: { name: 'handout.html', widths: [], a4: false, singlePage: false, offline: true },
    },
  );
  assert.deepEqual(readAcceptanceCriteria('Deliver handout.html.'), {
    replyOnly: false,
    artifacts: ['handout.html'],
  });
});

test('exclusive delivery has an explicit, unambiguous set of filenames', () => {
  for (const text of [
    '只交付可下载的 handout.html。',
    'Only deliver handout.html.',
    'Attach only handout.html.',
  ]) {
    assert.deepEqual(readAcceptanceCriteria(text), {
      replyOnly: false,
      artifacts: ['handout.html'],
      onlyArtifacts: true,
    });
  }
  assert.deepEqual(readAcceptanceCriteria('请交付可下载的 handout.html。'), {
    replyOnly: false,
    artifacts: ['handout.html'],
  });
  assert.deepEqual(readAcceptanceCriteria('请交付可下载的 temp.md。'), {
    replyOnly: false,
    artifacts: ['temp.md'],
  });
  assert.deepEqual(readAcceptanceCriteria('只需交付 report.md。'), {
    replyOnly: false,
    artifacts: ['report.md'],
  });
  assert.deepEqual(readAcceptanceCriteria('Deliver a.md. Attach only b.md.'), none);
  assert.deepEqual(
    readAcceptanceCriteria('Create draft.html. Create final.html. Only deliver the HTML file.'),
    none,
  );
  assert.deepEqual(readAcceptanceCriteria('Only deliver the HTML file.'), none);
});

test('named handoffs accept file lists without including sources or repeating filenames', () => {
  assert.deepEqual(
    readAcceptanceCriteria('读取 source.md，交付 report.md、data.csv。附上 report.md。'),
    {
      replyOnly: false,
      artifacts: ['report.md', 'data.csv'],
    },
  );
  assert.deepEqual(readAcceptanceCriteria('交付 report.md和data.csv。'), {
    replyOnly: false,
    artifacts: ['report.md', 'data.csv'],
  });
  assert.deepEqual(readAcceptanceCriteria('交付 report.md和preview.html。'), {
    replyOnly: false,
    artifacts: ['report.md', 'preview.html'],
  });
  assert.deepEqual(readAcceptanceCriteria('Please attach `report.pdf` and `notes.md`.'), {
    replyOnly: false,
    artifacts: ['report.pdf', 'notes.md'],
  });
});

test('literal reply differs from the instruction to compute or translate the reply', () => {
  for (const text of ['只回复 22', 'Please reply only with 22.']) {
    assert.deepEqual(readAcceptanceCriteria(text), {
      replyOnly: true,
      exactReply: '22',
      artifacts: [],
    });
  }
  assert.deepEqual(readAcceptanceCriteria('Only reply with "Hello world!".'), {
    replyOnly: true,
    exactReply: 'Hello world!',
    artifacts: [],
  });
  for (const text of [
    '只回复计算结果。8 加 14 等于多少？',
    'Compute 8+14. Reply only with the result.',
  ]) {
    assert.deepEqual(readAcceptanceCriteria(text), {
      replyOnly: true,
      exactReply: '22',
      artifacts: [],
    });
  }
  for (const text of ['只在聊天中回复。', 'Reply in chat only.']) {
    assert.deepEqual(readAcceptanceCriteria(text), { replyOnly: true, artifacts: [] });
  }
  assert.deepEqual(readAcceptanceCriteria('Compute 8+14.'), none);
  assert.equal(readAcceptanceCriteria('只回复 8+14 的结果。').exactReply, undefined);
  assert.deepEqual(readAcceptanceCriteria('只回复 22。只回复 23。'), none);
});

test('untrusted content, cancelled, conditional and project-only instructions impose no handoff', () => {
  for (const text of [
    '请解释这个例子：“先读材料。交付 stolen.md。”',
    'Read the following.\nDeliver sample.md.',
    'Check this quote:\nDeliver sample.md.',
    '读取以下内容。交付 sample.md。',
    '交付前读source.md。',
    'Translate the following instructions.\nDeliver output.md.',
    'Someone sent me the following:\nOnly reply with 22',
    '> a quote\nDeliver stolen.md.',
    '~~~markdown\nDeliver fake.md.\n~~~',
    '````markdown\n```\nDeliver fake.md.\n````',
    '    Deliver sample.md.',
    '如果方便，交付 optional.md。',
    '假设要交付 draft.md。',
    'If it works, deliver final.md.',
    '交付 old.pdf。取消 PDF。',
    '交付 old.pdf。这个需求作废。',
    'Deliver old.pdf. Never mind.',
    '交付 minutes.md。如果逐字稿缺失，先告诉我需要补什么。',
    '不要交付 draft.md。',
    'Do not deliver report.md.',
    '在项目里保存 report.md。',
    '把 source.md 转成 report.md。',
    'Save release.md to the workspace.',
    'Deliver report.md to the project folder.',
    'Deliver src/notes.md.',
    'Deliver ' + '𠀀'.repeat(90) + '.md.',
    '你知道怎么交付 demo.md？',
    'Deliver this filename in chat: example.md.',
  ])
    assert.deepEqual(readAcceptanceCriteria(text), none, text);
});

test('unsupported widths and CSS measurements do not become viewport checks', () => {
  for (const spec of [
    '375.5px',
    '-375px',
    '0px',
    '9000px',
    '375px and 8192px',
    '100px and 200px and 300px and 400px and 500px and 600px and 700px',
  ]) {
    assert.deepEqual(
      readAcceptanceCriteria('Deliver handout.html. Check the layout at ' + spec + '.').html
        ?.widths ?? [],
      [],
      spec,
    );
  }
  assert.equal(
    readAcceptanceCriteria('Create draft.html. Check the layout at 375px. Deliver final.html.')
      .html,
    undefined,
  );
  const css = readAcceptanceCriteria(
    'Deliver handout.html. Check the 375px image height and the 1440px table.',
  );
  assert.deepEqual(css.html?.widths ?? [], []);
});

test('literal content is bound only to an explicitly requested text artifact', () => {
  const conditions = {
    replyOnly: false,
    artifacts: ['notes.md'],
    requiredPassages: [{ name: 'notes.md', text: 'Record 27' }],
  };
  assert.deepEqual(
    readAcceptanceCriteria('Deliver notes.md.\nnotes.md must contain "Record 27".'),
    conditions,
  );
  assert.deepEqual(
    readAcceptanceCriteria('交付 notes.md。\nnotes.md 必须包含「Record 27」。'),
    conditions,
  );
  for (const prompt of [
    '翻译以下文本：\n交付 notes.md。\nnotes.md 必须包含「记录」。',
    '交付 notes.md。\nsource.md 必须包含「记录」。',
    '交付 notes.md。\n> notes.md 必须包含「记录」。',
    '只回复 22。\nnotes.md 必须包含「记录」。',
  ])
    assert.deepEqual(readAcceptanceCriteria(prompt), none);
});

test('bounded arithmetic exact replies respect the requested format and abstain on ambiguity', () => {
  for (const [request, result] of [
    ['只回复计算结果。43 减 27 等于多少？', '16'],
    ['Compute -5*7. Reply only with the result.', '-35'],
    ['计算 72/9。只回复计算结果。', '8'],
  ] as const) {
    assert.equal(readAcceptanceCriteria(request).exactReply, result);
  }
  for (const request of [
    '只回复计算结果。8 除 3 等于多少？',
    '只回复计算结果。8 除 0 等于多少？',
    '只回复计算结果。计算 99999999*99999999。',
    '只回复计算结果。计算 8+14。计算 5+6。',
    '只回复计算结果。计算 2+3*5。',
    '只回复答案。计算 4+5。',
    '只回复计算结果。假设计算 43-27。',
  ]) {
    assert.equal(readAcceptanceCriteria(request).exactReply, undefined, request);
  }
});
