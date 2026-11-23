/**
 * @file 管理桌面 profile 的版本化界面主题偏好。
 * @implementation 有界读取失败回到默认主题；将串行保存写到同目录临时文件，原子替换成功后才应用新主题。
 * @updated 2026-11-23T14:45:00+08:00
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaultUiTheme,
  desktopUiThemePreferenceSchema,
  resolveUiTheme,
  uiThemeSchema,
  type UiTheme,
} from '../../shared/desktop-ui-theme.js';

export const desktopUiThemeFilename = 'ui-theme.json';
const readTimeoutMs = 1_500;

type LoadOptions = {
  timeoutMs?: number;
  read?: (path: string, signal: AbortSignal) => Promise<string>;
};

export async function loadDesktopUiTheme(
  profile: string,
  options: LoadOptions = {},
): Promise<UiTheme> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const contents = await Promise.race([
      (options.read ?? ((path, signal) => readFile(path, { encoding: 'utf8', signal })))(
        join(profile, desktopUiThemeFilename),
        controller.signal,
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('UI theme preference read timed out.'));
        }, options.timeoutMs ?? readTimeoutMs);
      }),
    ]);
    return desktopUiThemePreferenceSchema.parse(JSON.parse(contents)).theme;
  } catch {
    return defaultUiTheme;
  } finally {
    clearTimeout(timeout);
  }
}

export class DesktopUiThemePreferences {
  private theme: UiTheme = defaultUiTheme;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly profile: string,
    private readonly apply: (theme: UiTheme) => void | Promise<unknown> = () => {},
  ) {}

  get(): UiTheme {
    return this.theme;
  }

  load(): Promise<UiTheme> {
    return this.serialize(async () => {
      const theme = await loadDesktopUiTheme(this.profile);
      await this.apply(theme);
      this.theme = theme;
      return theme;
    });
  }

  set(input: unknown, authorize: () => void = () => {}): Promise<UiTheme> {
    const theme = uiThemeSchema.parse(input);
    return this.serialize(async () => {
      authorize();
      const path = join(this.profile, desktopUiThemeFilename);
      const staged = join(this.profile, `.ui-theme-${randomUUID()}.tmp`);
      const preference = desktopUiThemePreferenceSchema.parse({ formatVersion: 1, theme });
      try {
        await mkdir(this.profile, { recursive: true, mode: 0o700 });
        await writeFile(staged, JSON.stringify(preference) + '\n', { flag: 'wx', mode: 0o600 });
        authorize();
        await rename(staged, path);
      } catch (error) {
        await rm(staged, { force: true }).catch(() => {});
        throw error;
      }
      await this.apply(theme);
      this.theme = theme;
      return theme;
    });
  }

  private serialize(operation: () => Promise<UiTheme>): Promise<UiTheme> {
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
