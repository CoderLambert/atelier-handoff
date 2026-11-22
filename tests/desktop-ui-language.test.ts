/**
 * @file 验证桌面语言偏好加载、原子保存与原生文案切换。
 * @implementation 在临时 profile 覆盖缺失、损坏、超时、保存失败、连接失效及串行提交，核对主进程动态翻译与诊断保留。
 * @updated 2026-11-22T16:00:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  desktopUiLanguageFilename,
  DesktopUiLanguagePreferences,
  loadDesktopUiLanguage,
} from '../desktop/host/ui-language.mjs';
import {
  desktopUiLanguageGetSchema,
  desktopUiLanguagePreferenceSchema,
  desktopUiLanguageResultSchema,
  desktopUiLanguageSetSchema,
} from '../shared/desktop-ui-language.js';
import type { UiLocale } from '../shared/i18n/locale.js';
import {
  asDesktopHostError,
  desktopI18n,
  desktopT,
  diagnosticText,
} from '../desktop/host/i18n.mjs';

async function profile(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-ui-language-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('desktop language IPC accepts only supported locale values and an empty get request', () => {
  assert.equal(desktopUiLanguageGetSchema.parse(undefined), undefined);
  assert.equal(desktopUiLanguageGetSchema.safeParse({}).success, false);
  for (const value of ['en', 'zh-CN']) {
    assert.equal(desktopUiLanguageSetSchema.parse(value), value);
    assert.equal(desktopUiLanguageResultSchema.parse(value), value);
  }
  for (const value of ['fr', 'en-US', null, { locale: 'en' }]) {
    assert.equal(desktopUiLanguageSetSchema.safeParse(value).success, false);
    assert.equal(desktopUiLanguageResultSchema.safeParse(value).success, false);
  }
});

test('missing, malformed, unsupported and unreadable desktop preferences use Chinese', async () => {
  await profile(async (directory) => {
    const path = join(directory, desktopUiLanguageFilename);
    assert.equal(await loadDesktopUiLanguage(directory), 'zh-CN');
    assert.deepEqual(await readdir(directory), []);
    for (const data of [
      '{',
      'null',
      JSON.stringify({ locale: 'en' }),
      JSON.stringify({ formatVersion: 2, locale: 'en' }),
      JSON.stringify({ formatVersion: 1, locale: 'fr' }),
      JSON.stringify({ formatVersion: 1, locale: 'en', unexpected: true }),
    ]) {
      await writeFile(path, data);
      assert.equal(await loadDesktopUiLanguage(directory), 'zh-CN', data);
    }
    await rm(path);
    await mkdir(path);
    assert.equal(await loadDesktopUiLanguage(directory), 'zh-CN');
  });
});

test('desktop preference reads have a deadline and abort a stalled read', async () => {
  let readSignal: AbortSignal | undefined;
  const locale = await loadDesktopUiLanguage('/unused-profile', {
    timeoutMs: 10,
    read: (_path, signal) => {
      readSignal = signal;
      return new Promise<string>(() => {});
    },
  });
  assert.equal(locale, 'zh-CN');
  assert.equal(readSignal?.aborted, true);
});

test('desktop language is applied after commit, persisted with a version and loaded on restart', async () => {
  await profile(async (directory) => {
    const path = join(directory, desktopUiLanguageFilename);
    const applied: UiLocale[] = [];
    const preferences = new DesktopUiLanguagePreferences(directory, async (locale) => {
      const data = desktopUiLanguagePreferenceSchema.parse(
        JSON.parse(await readFile(path, 'utf8')),
      );
      assert.equal(data.locale, locale);
      applied.push(locale);
    });
    assert.equal(preferences.get(), 'zh-CN');
    assert.equal(await preferences.set('en'), 'en');
    assert.equal(preferences.get(), 'en');
    assert.deepEqual(applied, ['en']);
    assert.equal(await loadDesktopUiLanguage(directory), 'en');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { formatVersion: 1, locale: 'en' });
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), [desktopUiLanguageFilename]);
    const restarted = new DesktopUiLanguagePreferences(directory, (locale) => {
      applied.push(locale);
    });
    assert.equal(await restarted.load(), 'en');
    assert.equal(restarted.get(), 'en');
    assert.deepEqual(applied, ['en', 'en']);
  });
});

test('failed desktop preference saves keep the current language and allow retry', async () => {
  await profile(async (directory) => {
    const path = join(directory, desktopUiLanguageFilename);
    const applied: UiLocale[] = [];
    const preferences = new DesktopUiLanguagePreferences(directory, (locale) => {
      applied.push(locale);
    });
    await mkdir(path);
    await assert.rejects(preferences.set('en'));
    assert.equal(preferences.get(), 'zh-CN');
    assert.deepEqual(applied, []);
    assert.deepEqual(await readdir(directory), [desktopUiLanguageFilename]);
    await rm(path, { recursive: true });
    assert.equal(await preferences.set('en'), 'en');
    assert.equal(preferences.get(), 'en');
    assert.deepEqual(applied, ['en']);
  });
});

test('a connection lost before preference commit preserves the saved language and removes staging', async () => {
  await profile(async (directory) => {
    const preferences = new DesktopUiLanguagePreferences(directory, () => {});
    await preferences.set('en');
    const path = join(directory, desktopUiLanguageFilename);
    const before = await readFile(path, 'utf8');
    let checks = 0;
    await assert.rejects(
      preferences.set('zh-CN', () => {
        if (++checks === 2) throw new Error('connection changed');
      }),
      /connection changed/,
    );
    assert.equal(preferences.get(), 'en');
    assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual(await readdir(directory), [desktopUiLanguageFilename]);
    assert.equal(await preferences.set('zh-CN'), 'zh-CN');
  });
});

test('concurrent desktop preference saves commit and apply in call order', async () => {
  await profile(async (directory) => {
    const applied: UiLocale[] = [];
    const preferences = new DesktopUiLanguagePreferences(directory, (locale) => {
      applied.push(locale);
    });
    assert.deepEqual(await Promise.all([preferences.set('en'), preferences.set('zh-CN')]), [
      'en',
      'zh-CN',
    ]);
    assert.deepEqual(applied, ['en', 'zh-CN']);
    assert.equal(preferences.get(), 'zh-CN');
    assert.equal(await loadDesktopUiLanguage(directory), 'zh-CN');
    assert.deepEqual(await readdir(directory), [desktopUiLanguageFilename]);
    assert.throws(() => preferences.set('fr'));
    assert.equal(preferences.get(), 'zh-CN');
  });
});

test('native desktop text follows the current main language and preserves raw diagnostics', async () => {
  const original = new Error('raw startup detail: EACCES');
  const failure = asDesktopHostError(original);
  try {
    await desktopI18n.changeLanguage('zh-CN');
    assert.equal(desktopT('host.files.chooseDirectory'), '选择项目目录');
    assert.equal(desktopT(failure.key), '工作台服务启动失败。请查看运行日志。');
    await desktopI18n.changeLanguage('en');
    assert.equal(desktopT('host.files.chooseDirectory'), 'Choose project directory');
    assert.equal(
      desktopT(failure.key),
      'The workspace service could not start. Check the runtime logs.',
    );
    assert.equal(failure.cause, original);
    assert.match(diagnosticText(failure.cause) ?? '', /raw startup detail: EACCES/);
    const data = { source: '/old/{{raw}}', destination: '/new/$1' };
    assert.match(desktopT('host.migration.confirmDetail', data), /Source: \/old\/\{\{raw\}\}/);
  } finally {
    await desktopI18n.changeLanguage('zh-CN');
  }
});
