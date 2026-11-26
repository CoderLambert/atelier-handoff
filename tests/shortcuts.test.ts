/**
 * @file 验证快捷键匹配、继承规则和独立设置的持久化。
 * @implementation 使用平台键盘事件样本、真实 HTTP 和临时 SQLite 验证快捷偏好。
 * @updated 2026-11-26T13:45:48Z
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { z } from 'zod';
import { createApp } from '../server/app.js';
import { desktopShortcutRegistrationSchema } from '../shared/desktop-shortcuts.js';
import {
  formatShortcutBinding,
  getNavigationKey,
  getShortcutBinding,
  matchShortcut,
  resolveShortcutBindings,
  shortcutBindingSchema,
  shortcutInputFromKeyboardEvent,
  shortcutPreferencesSchema,
  type ShortcutKeyInput,
  type ShortcutBinding,
  type ShortcutPreferences,
} from '../shared/shortcuts.js';

const defaults = { version: 1, enabled: true, bindings: {}, navigation: {} } as const;
const root = fileURLToPath(new URL('../', import.meta.url));
const endpoint = '/api/settings/shortcuts';

test('matches the physical key with exact platform modifiers and ignores composing events', () => {
  const binding = { code: 'Semicolon', modifiers: ['Mod'] } as const;
  const press: ShortcutKeyInput = {
    code: 'Semicolon',
    key: 'ö',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  };
  const shortcut = { ...binding, modifiers: [...binding.modifiers] };
  assert.equal(matchShortcut(press, shortcut, 'other'), true);
  assert.equal(matchShortcut(press, shortcut, 'mac'), false);
  assert.equal(matchShortcut({ ...press, ctrlKey: false, metaKey: true }, shortcut, 'mac'), true);
  assert.equal(formatShortcutBinding(shortcut, 'other'), 'Ctrl+;');
  assert.equal(formatShortcutBinding(shortcut, 'mac'), '⌘;');
  for (const change of [
    { code: 'Quote' },
    { key: 'Process' },
    { key: 'Dead' },
    { keyCode: 229 },
    { repeat: true },
    { isComposing: true },
    { altGraph: true },
    { shiftKey: true },
    { altKey: true },
    { metaKey: true },
    { defaultPrevented: true },
  ]) {
    assert.equal(matchShortcut({ ...press, ...change }, shortcut, 'other'), false);
  }
  const input = shortcutInputFromKeyboardEvent({
    ...press,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    getModifierState: (key) => key === 'AltGraph',
  });
  assert.equal(input.altGraph, true);
  assert.equal(matchShortcut(input, shortcut, 'other'), false);
});

test('inherits omitted bindings, supports explicit unbinding, and disables all entry points', () => {
  const overrides = shortcutPreferencesSchema.parse({
    ...defaults,
    bindings: { 'sessions.switch': null },
    navigation: { 'shortcuts.settings': null, 'future.action': 'x' },
  });
  assert.deepEqual(getShortcutBinding(overrides, 'shortcuts.navigator'), {
    code: 'Semicolon',
    modifiers: ['Mod', 'Shift'],
  });
  assert.equal(getShortcutBinding(overrides, 'sessions.switch'), null);
  assert.equal(getShortcutBinding(overrides, 'panels.git'), null);
  assert.equal(getNavigationKey(overrides, 'sessions.switch'), 'S');
  assert.equal(getNavigationKey(overrides, 'shortcuts.settings'), null);
  assert.equal(getNavigationKey(overrides, 'future.action'), 'X');
  assert.deepEqual(
    resolveShortcutBindings(overrides).map(({ commandId }) => commandId),
    ['shortcuts.navigator'],
  );
  const disabled = { ...overrides, enabled: false };
  assert.equal(getShortcutBinding(disabled, 'shortcuts.navigator'), null);
  assert.equal(getNavigationKey(disabled, 'sessions.switch'), null);
  assert.deepEqual(resolveShortcutBindings(disabled), []);
});

test('rejects duplicate effective shortcuts and protects existing keyboard commands', () => {
  for (const binding of [
    { code: 'KeyH', modifiers: [] },
    { code: 'ControlLeft', modifiers: ['Mod'] },
    { code: 'Semicolon', modifiers: ['Control', 'Alt'] },
    { code: 'Semicolon', modifiers: ['Mod', 'Alt'] },
    { code: 'Semicolon', modifiers: ['Mod', 'Control'] },
    { code: 'Semicolon', modifiers: ['Shift', 'Shift'] },
    { code: 'KeyQ', modifiers: ['Alt', 'Shift'] },
    { code: 'Enter', modifiers: ['Control'] },
    { code: 'Enter', modifiers: ['Meta'] },
    { code: 'Enter', modifiers: ['Alt'] },
    { code: 'KeyW', modifiers: ['Mod'] },
    { code: 'KeyQ', modifiers: ['Mod'] },
    { code: 'KeyI', modifiers: ['Meta', 'Alt'] },
    { code: 'KeyA', modifiers: ['Control', 'Shift'] },
    { code: 'NumpadAdd', modifiers: ['Control'] },
    { code: 'KeyD', modifiers: ['Alt'] },
    { code: 'Comma', modifiers: ['Mod'] },
    { code: 'Tab', modifiers: ['Alt'] },
  ]) {
    assert.equal(shortcutBindingSchema.safeParse(binding).success, false, JSON.stringify(binding));
  }
  const withConflicts = {
    ...defaults,
    bindings: { 'future.action': { code: 'Semicolon', modifiers: ['Control'] } },
    navigation: { 'future.action': 'g' },
  };
  const result = shortcutPreferencesSchema.safeParse(withConflicts);
  assert.equal(result.success, false);
  assert.deepEqual(result.error.issues.map((issue) => issue.path).sort(), [
    ['bindings', 'future.action'],
    ['navigation', 'future.action'],
  ]);
  assert.deepEqual(result.error.issues.map((issue) => issue.message).sort(), [
    'DUPLICATE_BINDING',
    'DUPLICATE_NAVIGATION',
  ]);
  assert.equal(
    shortcutPreferencesSchema.safeParse({
      ...withConflicts,
      bindings: { ...withConflicts.bindings, 'sessions.switch': null },
      navigation: { ...withConflicts.navigation, 'panels.git': null },
    }).success,
    true,
  );
  for (const settings of [
    { extra: true },
    { version: 2 },
    { navigation: { 'future.action': 'xy' } },
  ]) {
    assert.equal(shortcutPreferencesSchema.safeParse({ ...defaults, ...settings }).success, false);
  }
  const oversized = Object.fromEntries(
    Array.from({ length: 129 }, (_, i) => [`future.item${i}`, null]),
  );
  assert.equal(
    shortcutPreferencesSchema.safeParse({ ...defaults, bindings: oversized }).success,
    false,
  );
});

test('preserves terminal control bytes, browser navigation, and text selection in native registration', () => {
  const reserved: ShortcutBinding[] = [
    ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter): ShortcutBinding => ({
      code: `Key${letter}`,
      modifiers: ['Control'],
    })),
    ...['BracketLeft', 'BracketRight', 'Backslash'].map((code): ShortcutBinding => ({
      code,
      modifiers: ['Control'],
    })),
    { code: 'BracketLeft', modifiers: ['Meta'] },
    { code: 'BracketRight', modifiers: ['Meta'] },
    { code: 'BracketRight', modifiers: ['Mod'] },
    { code: 'Home', modifiers: ['Control', 'Shift'] },
    { code: 'End', modifiers: ['Control', 'Shift'] },
    { code: 'KeyO', modifiers: ['Control', 'Shift'] },
    { code: 'KeyB', modifiers: ['Meta', 'Alt'] },
    { code: 'KeyT', modifiers: ['Alt', 'Shift'] },
    { code: 'KeyN', modifiers: ['Alt'] },
    { code: 'Digit8', modifiers: ['Alt'] },
    { code: 'Backquote', modifiers: ['Alt'] },
    { code: 'Numpad5', modifiers: ['Alt'] },
  ];
  const registration = (binding: ShortcutBinding) => ({
    revision: 'test-1',
    bindings: [{ commandId: 'future.action', binding }],
  });
  for (const binding of reserved) {
    assert.equal(shortcutBindingSchema.safeParse(binding).success, false, JSON.stringify(binding));
    assert.equal(desktopShortcutRegistrationSchema.safeParse(registration(binding)).success, false);
  }
  for (const modifiers of [['Mod'], ['Mod', 'Shift']] as const) {
    const binding = { code: 'Semicolon', modifiers: [...modifiers] };
    assert.equal(desktopShortcutRegistrationSchema.safeParse(registration(binding)).success, true);
  }
});

test('saves shortcuts independently across runtime restarts and recovers corrupt settings', async () => {
  const data = await mkdtemp(join(tmpdir(), 'atelier-shortcuts-'));
  let app = await createApp({ root, data });
  async function connect() {
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const { csrfToken } = z
      .object({ csrfToken: z.string() })
      .parse(await fetch(origin + '/api/bootstrap').then((response) => response.json()));
    return async (method = 'GET', body?: unknown, expected = 200) => {
      const response = await fetch(origin + endpoint, {
        method,
        headers: { 'content-type': 'application/json', 'x-atelier-token': csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value: unknown = await response.json();
      assert.equal(response.status, expected, JSON.stringify(value));
      return value;
    };
  }
  try {
    const layout = app.store.workspaceLayout.read();
    const modelPreferences = app.store.gitMultiCommitPreferences.read();
    let request = await connect();
    assert.deepEqual(await request(), defaults);
    const saved: ShortcutPreferences = {
      ...defaults,
      enabled: false,
      bindings: {
        'sessions.switch': null,
        'future.action': { code: 'KeyY', modifiers: ['Alt', 'Shift'] },
      },
      navigation: { 'panels.git': 'X', 'composer.focus': null },
    };
    assert.deepEqual(await request('PATCH', saved), saved);
    await request('PATCH', { ...saved, navigation: { 'future.action': 'J' } }, 400);
    assert.deepEqual(await request(), saved);
    await app.close();
    app = await createApp({ root, data });
    request = await connect();
    assert.deepEqual(await request(), saved);
    assert.deepEqual(app.store.workspaceLayout.read(), layout);
    assert.deepEqual(app.store.gitMultiCommitPreferences.read(), modelPreferences);
    app.store.db
      .prepare('UPDATE settings SET value=? WHERE key=?')
      .run('{broken', 'shortcut-preferences-v1');
    assert.deepEqual(await request(), defaults);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
