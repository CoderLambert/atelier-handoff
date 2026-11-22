/**
 * @file 管理桌面 profile 的版本化界面语言偏好。
 * @implementation 有界读取失败回到默认语言；将串行保存写到同目录临时文件，原子替换成功后才应用新语言。
 * @updated 2026-11-22T16:00:00+08:00
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopUiLanguagePreferenceSchema } from '../../shared/desktop-ui-language.js';
import { defaultUiLocale, uiLocaleSchema, type UiLocale } from '../../shared/i18n/locale.js';

export const desktopUiLanguageFilename = 'ui-language.json';
const readTimeoutMs = 1_500;

type LoadOptions = {
  timeoutMs?: number;
  read?: (path: string, signal: AbortSignal) => Promise<string>;
};

export async function loadDesktopUiLanguage(
  profile: string,
  options: LoadOptions = {},
): Promise<UiLocale> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const contents = await Promise.race([
      (options.read ?? ((path, signal) => readFile(path, { encoding: 'utf8', signal })))(
        join(profile, desktopUiLanguageFilename),
        controller.signal,
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('UI language preference read timed out.'));
        }, options.timeoutMs ?? readTimeoutMs);
      }),
    ]);
    return desktopUiLanguagePreferenceSchema.parse(JSON.parse(contents)).locale;
  } catch {
    return defaultUiLocale;
  } finally {
    clearTimeout(timeout);
  }
}

export class DesktopUiLanguagePreferences {
  private locale: UiLocale = defaultUiLocale;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly profile: string,
    private readonly apply: (locale: UiLocale) => void | Promise<unknown>,
  ) {}

  get(): UiLocale {
    return this.locale;
  }

  load(): Promise<UiLocale> {
    return this.serialize(async () => {
      const locale = await loadDesktopUiLanguage(this.profile);
      await this.apply(locale);
      this.locale = locale;
      return locale;
    });
  }

  set(input: unknown, authorize: () => void = () => {}): Promise<UiLocale> {
    const locale = uiLocaleSchema.parse(input);
    return this.serialize(async () => {
      authorize();
      const path = join(this.profile, desktopUiLanguageFilename);
      const staged = join(this.profile, `.ui-language-${randomUUID()}.tmp`);
      const preference = desktopUiLanguagePreferenceSchema.parse({ formatVersion: 1, locale });
      try {
        await mkdir(this.profile, { recursive: true, mode: 0o700 });
        await writeFile(staged, JSON.stringify(preference) + '\n', { flag: 'wx', mode: 0o600 });
        authorize();
        await rename(staged, path);
      } catch (error) {
        await rm(staged, { force: true }).catch(() => {});
        throw error;
      }
      await this.apply(locale);
      this.locale = locale;
      return locale;
    });
  }

  private serialize(operation: () => Promise<UiLocale>): Promise<UiLocale> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
