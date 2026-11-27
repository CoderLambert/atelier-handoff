/**
 * @file 验证扩展兼容性诊断按展示场景本地化。
 * @implementation 对同一包诊断核对中英文扩展详情和 GitHub 安装预览。
 * @updated 2026-11-27T16:55:00+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uiI18n } from '@/i18n';
import { extensionDetail } from './api';

test('packaged extension diagnostics distinguish details from GitHub install previews', async () => {
  const diagnostic = '此扩展包含动态命令、钩子、专用权限配置或包中不存在的附属文件。';
  try {
    await uiI18n.changeLanguage('en');
    assert.equal(
      extensionDetail(diagnostic),
      'This extension contains dynamic commands, hooks, custom permission settings, or supporting files missing from the package.',
    );
    assert.match(extensionDetail(diagnostic, 'github-preview'), /It installs disabled\.$/);
    await uiI18n.changeLanguage('zh-CN');
    assert.equal(extensionDetail(diagnostic), diagnostic);
    assert.match(extensionDetail(diagnostic, 'github-preview'), /安装后会保持停用。$/);
    assert.equal(extensionDetail('external diagnostic', 'github-preview'), 'external diagnostic');
  } finally {
    await uiI18n.changeLanguage('zh-CN');
  }
});
