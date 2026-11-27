/**
 * @file 验证扩展兼容性诊断与表单校验的双语本地化。
 * @implementation 对同一包诊断核对中英文扩展详情和 GitHub 安装预览，并验证统一表单校验在双语下输出正确提示。
 * @updated 2026-11-27T21:30:00+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uiI18n } from '@/i18n';
import { extensionDetail } from './api';
import { parseExtensionPayload } from './validation';

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

test('parseExtensionPayload localizes shared extension contract failures in zh-CN and en', async () => {
  const invalidCases: Array<[unknown, RegExp, RegExp]> = [
    [
      { kind: 'command', name: 'BadName', description: '', enabled: true, body: 'hi' },
      /64 个字符/,
      /64 lowercase/,
    ],
    [
      {
        kind: 'mcp',
        name: 'remote',
        description: '',
        enabled: true,
        transport: { type: 'http', url: 'http://example.com/mcp' },
      },
      /HTTPS 或本机 HTTP/,
      /HTTPS or localhost HTTP/,
    ],
    [
      {
        kind: 'mcp',
        name: 'local-env',
        description: '',
        enabled: true,
        transport: {
          type: 'stdio',
          command: '/usr/bin/node',
          args: [],
          envNames: ['lower_var'],
        },
      },
      /大写字母/,
      /uppercase letters/,
    ],
    [
      {
        kind: 'mcp',
        name: 'rel-cmd',
        description: '',
        enabled: true,
        transport: {
          type: 'stdio',
          command: 'relative',
          args: [],
          envNames: [],
        },
      },
      /绝对路径/,
      /absolute path/,
    ],
  ];
  try {
    for (const [payload, zhPattern, enPattern] of invalidCases) {
      await uiI18n.changeLanguage('zh-CN');
      assert.throws(() => parseExtensionPayload(payload), zhPattern);
      await uiI18n.changeLanguage('en');
      assert.throws(() => parseExtensionPayload(payload), enPattern);
    }
  } finally {
    await uiI18n.changeLanguage('zh-CN');
  }
});
