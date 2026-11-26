/**
 * @file 验证快捷操作的按键生命周期和导航边界。
 * @implementation 用纯状态机覆盖长按、输入法收尾、失焦复位与导航可用性，避免已消费按键泄漏到输入区。
 * @updated 2026-11-26T22:00:00+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultShortcutPreferences, type ShortcutKeyInput } from '@shared/shortcuts';
import {
  createShortcutKeyGuard,
  navigationCommand,
  nextAvailableCommand,
} from './shortcut-interaction';

function input(code: string, key: string, extra: Partial<ShortcutKeyInput> = {}): ShortcutKeyInput {
  return { code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra };
}

test('consumed navigation keys suppress repeats after focus moves into the composer', () => {
  const guard = createShortcutKeyGuard();
  guard.consume('KeyI');
  assert.equal(guard.suppresses(input('KeyI', 'i', { repeat: true })), true);
  assert.equal(guard.suppresses(input('KeyO', 'o', { repeat: true })), false);
  guard.release('KeyI');
  assert.equal(guard.suppresses(input('KeyI', 'i', { repeat: true })), false);
});

test('a fresh keydown recovers from a keyup delivered to a different native surface', () => {
  const guard = createShortcutKeyGuard();
  guard.consume('Semicolon');
  assert.equal(guard.suppresses(input('Semicolon', ';')), false);
  assert.equal(guard.suppresses(input('Semicolon', ';', { repeat: true })), false);
});

test('composition finish, Process, Dead, AltGraph and repeats never activate commands', () => {
  const guard = createShortcutKeyGuard();
  guard.compositionStart();
  assert.equal(guard.accepts(input('KeyI', 'i'), 100), false);
  guard.compositionEnd(100);
  assert.equal(guard.accepts(input('KeyI', 'i'), 140), false);
  assert.equal(guard.accepts(input('KeyI', 'i'), 181), true);
  for (const extra of [
    { isComposing: true },
    { key: 'Process' },
    { key: 'Dead' },
    { keyCode: 229 },
    { altGraph: true },
    { repeat: true },
    { defaultPrevented: true },
  ])
    assert.equal(guard.accepts(input('KeyI', 'i', extra), 181), false);
});

test('blur reset releases held keys and composition state', () => {
  const guard = createShortcutKeyGuard();
  guard.consume('Escape');
  guard.compositionStart();
  guard.reset();
  assert.equal(guard.suppresses(input('Escape', 'Escape', { repeat: true })), false);
  assert.equal(guard.accepts(input('KeyI', 'i'), 0), true);
});

test('navigator resolves only an available unmodified action', () => {
  const commands = [
    { id: 'composer.focus', available: true },
    { id: 'panels.git', available: false },
  ];
  assert.equal(
    navigationCommand(input('KeyI', 'i'), defaultShortcutPreferences, commands),
    'composer.focus',
  );
  assert.equal(
    navigationCommand(input('KeyG', 'g'), defaultShortcutPreferences, commands),
    undefined,
  );
  assert.equal(
    navigationCommand(input('KeyI', 'i', { ctrlKey: true }), defaultShortcutPreferences, commands),
    undefined,
  );
  assert.equal(
    navigationCommand(
      input('KeyI', 'i', { isComposing: true }),
      defaultShortcutPreferences,
      commands,
    ),
    undefined,
  );
  assert.equal(
    navigationCommand(
      input('KeyI', 'i'),
      { ...defaultShortcutPreferences, enabled: false },
      commands,
    ),
    undefined,
  );
});

test('navigation uses saved overrides and follows only available commands', () => {
  const commands = [
    { id: 'layout.toggleLeft', available: true },
    { id: 'layout.toggleRight', available: false },
    { id: 'composer.focus', available: true },
  ];
  const preferences = { ...defaultShortcutPreferences, navigation: { 'composer.focus': 'U' } };
  assert.equal(navigationCommand(input('KeyI', 'i'), preferences, commands), undefined);
  assert.equal(navigationCommand(input('KeyU', 'u'), preferences, commands), 'composer.focus');
  assert.equal(nextAvailableCommand(commands, 'layout.toggleLeft', 1), 'composer.focus');
  assert.equal(nextAvailableCommand(commands, 'composer.focus', 1), 'layout.toggleLeft');
  assert.equal(nextAvailableCommand(commands, undefined, -1), 'composer.focus');
  assert.equal(nextAvailableCommand([], undefined, 1), undefined);
});
