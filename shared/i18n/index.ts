/**
 * @file 初始化离线界面翻译。
 * @implementation 从双语目录构建 i18next 类型化资源，由各进程独立消费。
 * @updated 2026-11-22T15:00:00+08:00
 */
import i18next from 'i18next';
import { browser } from './catalogs/browser.js';
import { chat } from './catalogs/chat.js';
import { common } from './catalogs/common.js';
import { desktop } from './catalogs/desktop.js';
import { extensions } from './catalogs/extensions.js';
import { git } from './catalogs/git.js';
import { inspector } from './catalogs/inspector.js';
import { navigation } from './catalogs/navigation.js';
import { workbench } from './catalogs/workbench.js';
import { uiLocales, type UiLocale } from './locale.js';

export const catalogs = {
  common,
  workbench,
  chat,
  inspector,
  extensions,
  desktop,
  browser,
  navigation,
  git,
};
export type UiNamespace = keyof typeof catalogs;

type Catalogs = typeof catalogs;
type Resources<Index extends 0 | 1> = {
  [Ns in UiNamespace]: {
    [Key in keyof Catalogs[Ns]]: Catalogs[Ns][Key] extends readonly [string, string]
      ? Catalogs[Ns][Key][Index]
      : never;
  };
};

type Dictionaries = Readonly<Record<string, Readonly<Record<string, readonly [string, string]>>>>;

function entriesAt(
  dictionaries: Dictionaries,
  index: 0 | 1,
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const [namespace, messages] of Object.entries(dictionaries)) {
    const localeMessages: Record<string, string> = {};
    for (const [key, pair] of Object.entries(messages)) localeMessages[key] = pair[index];
    result[namespace] = localeMessages;
  }
  return result;
}

// The conversion preserves the exact catalog keys and selects only the indicated tuple entry.
export const resources = {
  'zh-CN': entriesAt(catalogs, 0) as Resources<0>,
  en: entriesAt(catalogs, 1) as Resources<1>,
};

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: typeof resources.en;
    keySeparator: false;
    strictKeyChecks: true;
    enableSelector: false;
  }
}

export function createUiI18n(locale: UiLocale) {
  const instance = i18next.createInstance();
  void instance.init({
    lng: locale,
    supportedLngs: [...uiLocales],
    fallbackLng: 'en',
    resources,
    ns: Object.keys(catalogs),
    defaultNS: 'common',
    keySeparator: false,
    initAsync: false,
    // React and native controls render interpolated values as text.
    interpolation: { escapeValue: false, skipOnVariables: true },
  });
  return instance;
}
