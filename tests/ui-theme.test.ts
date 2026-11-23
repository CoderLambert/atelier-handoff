/**
 * @file 验证界面多套主题皮肤切换与存储逻辑。
 * @implementation 验证黑曜工作室、工坊经典、暖纸书卷、冰川冷白、晨曦蔷薇与深空墨夜等主题类型解析、默认值、桌面 profile 持久化与 IPC 契约。
 * @updated 2026-11-23T14:50:00+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  allUiThemes,
  defaultUiTheme,
  desktopUiThemeChannels,
  desktopUiThemeGetSchema,
  desktopUiThemePreferenceSchema,
  desktopUiThemeResultSchema,
  desktopUiThemeSetSchema,
  resolveUiTheme,
  uiThemeSchema,
} from '../shared/desktop-ui-theme.js';
import {
  desktopUiThemeFilename,
  DesktopUiThemePreferences,
  loadDesktopUiTheme,
} from '../desktop/host/ui-theme.mjs';

async function withProfile(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-ui-theme-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('theme service resolves valid themes and falls back to default', () => {
  assert.equal(defaultUiTheme, 'obsidian');
  assert.equal(resolveUiTheme('classic'), 'classic');
  assert.equal(resolveUiTheme('parchment'), 'parchment');
  assert.equal(resolveUiTheme('nordic'), 'nordic');
  assert.equal(resolveUiTheme('rose'), 'rose');
  assert.equal(resolveUiTheme('midnight'), 'midnight');
  assert.equal(resolveUiTheme('obsidian'), 'obsidian');
  assert.equal(resolveUiTheme('unknown'), 'obsidian');
  assert.equal(resolveUiTheme(null), 'obsidian');
  assert.equal(resolveUiTheme(undefined), 'obsidian');
  assert.equal(allUiThemes.length, 6);
});

test('desktop theme IPC channels and schemas validate payloads', () => {
  assert.equal(desktopUiThemeChannels.get, 'atelier-ui-theme:get');
  assert.equal(desktopUiThemeChannels.set, 'atelier-ui-theme:set');
  assert.equal(desktopUiThemeGetSchema.parse(undefined), undefined);
  assert.equal(desktopUiThemeGetSchema.safeParse({}).success, false);

  for (const theme of allUiThemes) {
    assert.equal(desktopUiThemeSetSchema.parse(theme), theme);
    assert.equal(desktopUiThemeResultSchema.parse(theme), theme);
    assert.equal(uiThemeSchema.parse(theme), theme);
  }
  assert.equal(desktopUiThemeSetSchema.safeParse('invalid-theme').success, false);
});

test('desktop theme preference persists in user profile across loads', async () => {
  await withProfile(async (directory) => {
    // 初始不存在时回到默认主题
    assert.equal(await loadDesktopUiTheme(directory), 'obsidian');

    const preferences = new DesktopUiThemePreferences(directory);
    await preferences.load();
    assert.equal(preferences.get(), 'obsidian');

    // 切换到 parchment
    await preferences.set('parchment');
    assert.equal(preferences.get(), 'parchment');

    // 重新载入检查磁盘持久化文件
    const contents = JSON.parse(await readFile(join(directory, desktopUiThemeFilename), 'utf8'));
    assert.deepEqual(contents, { formatVersion: 1, theme: 'parchment' });

    const reloaded = new DesktopUiThemePreferences(directory);
    await reloaded.load();
    assert.equal(reloaded.get(), 'parchment');

    // 切换到 midnight
    await reloaded.set('midnight');
    assert.equal(reloaded.get(), 'midnight');
    assert.equal(await loadDesktopUiTheme(directory), 'midnight');
  });
});
