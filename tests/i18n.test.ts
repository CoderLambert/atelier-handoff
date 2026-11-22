/**
 * @file 验证本地化目录、语言解析和文本检查。
 * @implementation 覆盖真实词条查找，以及能和不能通过的界面源码片段。
 * @updated 2026-11-22T22:42:37+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCatalog, scanI18nSource } from '../scripts/check-i18n.mjs';
import { createUiI18n } from '../shared/i18n/index.js';
import { resolveUiLocale } from '../shared/i18n/locale.js';

test('language defaults and changes use the bundled catalogs without a fetch', async () => {
  assert.equal(resolveUiLocale(undefined), 'zh-CN');
  assert.equal(resolveUiLocale('fr'), 'zh-CN');
  assert.equal(resolveUiLocale('en'), 'en');
  const ui = createUiI18n('zh-CN');
  const t = ui.getFixedT(null, 'workbench');
  assert.equal(t('changes.pending', { count: 2 }), '变更记录 · 待审批 2');
  await ui.changeLanguage('en');
  assert.equal(t('changes.pending', { count: 1 }), 'Changes · 1 approval pending');
  assert.equal(t('changes.pending', { count: 2 }), 'Changes · 2 approvals pending');
  assert.equal(
    t('session.branchCreated', { title: '中文 & English' }),
    'Created branch “中文 & English”.',
  );
});

test('checker detects Chinese and English labels in JSX and native dialogs', () => {
  const findings = scanI18nSource(
    `const option = { label: 'English text' };
    const closeLabel = '关闭';
    const view = <button aria-label={closeLabel}>{ok ? 'Ready' : t('busy')}</button>;
    dialog.showMessageBox({ message: \`失败 \${count}\`, buttons: ['Retry'] });`,
    true,
  );
  assert.deepEqual(
    findings.map(({ text }) => text),
    ['English text', '关闭', 'Ready', '失败', 'Retry'],
  );
  assert.deepEqual(
    scanI18nSource(
      `const option = { labelKey: 'dialog.close', id: 'active' };
    const view = <button aria-label={t(option.labelKey)} type="submit">{file.name} →</button>;`,
      true,
    ),
    [],
  );
});

test('checker rejects incomplete or inconsistent localized messages', () => {
  assert.deepEqual(checkCatalog({ 'test.name': ['例子 {{name}}', 'Example {{name}}'] }), []);
  assert.deepEqual(checkCatalog({ 'test.name': ['例子 {{name}}', 'Example {{other}}'] }), [
    'test.name: interpolation variables differ',
  ]);
  assert.deepEqual(checkCatalog({ 'test.count_other': ['{{count}} 项', '{{count}} items'] }), [
    'test.count: missing one plural branch',
  ]);
});
