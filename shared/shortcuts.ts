/**
 * @file 定义工作台快捷操作的绑定、默认值和匹配契约。
 * @implementation 按平台解析精确修饰键，校验继承后重复项及浏览器、系统和应用保留组合。
 * @updated 2026-11-26T13:45:48Z
 */
import { z } from 'zod';

export type ShortcutPlatform = 'mac' | 'other';
const modifiers = ['Mod', 'Control', 'Meta', 'Alt', 'Shift'] as const;
export type ShortcutModifier = (typeof modifiers)[number];
export interface ShortcutKeyInput {
  code: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  altGraph?: boolean;
  defaultPrevented?: boolean;
}

const defaultBindings: Record<string, ShortcutBinding> = {
  'shortcuts.navigator': { code: 'Semicolon', modifiers: ['Mod', 'Shift'] },
  'sessions.switch': { code: 'Semicolon', modifiers: ['Mod'] },
};
const defaultNavigation: Record<string, string> = {
  'shortcuts.settings': ',',
  'sessions.switch': 'S',
  'sessions.previous': 'K',
  'sessions.next': 'J',
  'layout.toggleLeft': 'H',
  'layout.toggleRight': 'L',
  'composer.focus': 'I',
  'panels.git': 'G',
  'panels.terminal': 'T',
  'panels.browser': 'B',
};
export const defaultShortcutPreferences: ShortcutPreferences = Object.freeze({
  version: 1,
  enabled: true,
  bindings: Object.freeze({}),
  navigation: Object.freeze({}),
});

const platforms = ['mac', 'other'] as const;
const modifierMask = { Control: 1, Meta: 2, Alt: 4, Shift: 8 } as const;
type PhysicalModifier = keyof typeof modifierMask;

function physicalModifier(
  modifier: ShortcutModifier,
  platform: ShortcutPlatform,
): PhysicalModifier {
  if (modifier !== 'Mod') return modifier;
  return platform === 'mac' ? 'Meta' : 'Control';
}

function bindingMask(modifiers: readonly ShortcutModifier[], platform: ShortcutPlatform): number {
  return modifiers.reduce(
    (mask, modifier) => mask | modifierMask[physicalModifier(modifier, platform)],
    0,
  );
}

const characterCode =
  /^(?:Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Equal)|Backquote|Backslash|BracketLeft|BracketRight|Comma|Equal|Minus|Period|Quote|Semicolon|Slash|IntlBackslash|IntlRo|IntlYen)$/u;
const nonCharacterCode =
  /^(?:F(?:[1-9]|1[0-9]|2[0-4])|NumpadEnter|Arrow(?:Left|Right|Up|Down)|Space|Tab|Backspace|Delete|End|Enter|Escape|Home|Insert|PageDown|PageUp)$/u;
// xterm.js sends these unshifted Control combinations as terminal control bytes.
const terminalControlCode = /^(?:Key[A-Z]|BracketLeft|BracketRight|Backslash)$/u;

const primaryReserved = new Set([
  'KeyA',
  'KeyC',
  'KeyD',
  'KeyF',
  'KeyG',
  'KeyH',
  'KeyJ',
  'KeyK',
  'KeyL',
  'KeyN',
  'KeyO',
  'KeyP',
  'KeyR',
  'KeyS',
  'KeyT',
  'KeyU',
  'KeyV',
  'KeyW',
  'KeyX',
  'KeyY',
  'KeyZ',
  'Equal',
  'Minus',
  'Space',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'NumpadAdd',
  'NumpadSubtract',
  'Numpad0',
  'F4',
  'F5',
]);
const primaryShiftReserved = new Set([
  'KeyA',
  'KeyB',
  'KeyC',
  'KeyD',
  'KeyG',
  'KeyI',
  'KeyJ',
  'KeyN',
  'KeyO',
  'KeyP',
  'KeyR',
  'KeyS',
  'KeyT',
  'KeyV',
  'KeyW',
  'KeyZ',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'F5',
  'Equal',
]);
const altReserved = new Set([
  'ArrowLeft',
  'ArrowRight',
  'F4',
  'F10',
  'Home',
  'Space',
  'Tab',
  'Delete',
  'KeyD',
  'KeyE',
  'KeyF',
]);
const macMetaReserved = new Set(['Comma', 'KeyM', 'KeyQ']);
const macMetaAltReserved = new Set(['KeyB', 'KeyC', 'KeyI', 'KeyJ', 'KeyU']);
const nonMacMetaReserved = new Set([
  'KeyD',
  'KeyE',
  'KeyG',
  'KeyI',
  'KeyK',
  'KeyL',
  'KeyM',
  'KeyN',
  'KeyP',
  'KeyR',
  'KeyS',
  'KeyU',
  'KeyV',
  'KeyX',
  'KeyZ',
  'Space',
  'Tab',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
]);

function reserved(code: string, mask: number, platform: ShortcutPlatform): boolean {
  const control = Boolean(mask & modifierMask.Control);
  const meta = Boolean(mask & modifierMask.Meta);
  const alt = Boolean(mask & modifierMask.Alt);
  const shift = Boolean(mask & modifierMask.Shift);
  if (!control && !meta && !alt) return true;
  if (control && alt) return true;
  if (code === 'Enter' || code === 'NumpadEnter' || code === 'Escape') return true;
  if (mask === modifierMask.Control && terminalControlCode.test(code)) return true;
  if (mask === modifierMask.Alt && characterCode.test(code)) return true;
  if (alt && altReserved.has(code)) return true;
  if (alt && shift && !meta && (code === 'KeyQ' || code === 'KeyT')) return true;
  if (platform === 'other' && meta && nonMacMetaReserved.has(code)) return true;
  if (platform === 'mac' && mask === modifierMask.Meta && /^Bracket(?:Left|Right)$/u.test(code))
    return true;
  if (
    platform === 'mac' &&
    meta &&
    (macMetaReserved.has(code) || (alt && macMetaAltReserved.has(code)))
  )
    return true;
  if (control || meta) {
    if (shift) return primaryShiftReserved.has(code);
    return primaryReserved.has(code) || /^Digit[0-9]$/u.test(code);
  }
  return false;
}

export const shortcutBindingSchema = z
  .strictObject({
    code: z
      .string()
      .max(20)
      .refine((code) => characterCode.test(code) || nonCharacterCode.test(code)),
    modifiers: z.array(z.enum(modifiers)).min(1).max(modifiers.length),
  })
  .superRefine((binding, context) => {
    if (
      platforms.some((platform) => {
        const physical = new Set(
          binding.modifiers.map((modifier) => physicalModifier(modifier, platform)),
        );
        return physical.size !== binding.modifiers.length;
      })
    ) {
      context.addIssue({ code: 'custom', path: ['modifiers'], message: 'DUPLICATE_MODIFIER' });
    } else if (
      platforms.some((platform) =>
        reserved(binding.code, bindingMask(binding.modifiers, platform), platform),
      )
    ) {
      context.addIssue({ code: 'custom', path: ['code'], message: 'RESERVED_BINDING' });
    }
  });
export type ShortcutBinding = z.infer<typeof shortcutBindingSchema>;

export const shortcutCommandIdSchema = z
  .string()
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z][A-Za-z0-9]*)*$/u)
  .refine((id) => !Object.hasOwn(Object.prototype, id));
const navigationKey = z
  .string()
  .regex(/^[A-Za-z0-9,]$/u, { message: 'INVALID_NAVIGATION' })
  .transform((key) => key.toUpperCase());
const maxOverrides = 128;

function ownValue<T>(record: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(record, id) ? record[id] : undefined;
}

function conflictingIds<T>(
  defaults: Record<string, T>,
  overrides: Record<string, T | null>,
  signature: (value: T) => string,
): Set<string> {
  const conflicts = new Set<string>();
  const bySignature = new Map<string, string>();
  for (const [id, value] of Object.entries({ ...defaults, ...overrides })) {
    if (value === null) continue;
    const key = signature(value);
    const prior = bySignature.get(key);
    if (prior === undefined) bySignature.set(key, id);
    else {
      if (Object.hasOwn(overrides, prior)) conflicts.add(prior);
      if (Object.hasOwn(overrides, id)) conflicts.add(id);
    }
  }
  return conflicts;
}

export const shortcutPreferencesSchema = z
  .strictObject({
    version: z.literal(1),
    enabled: z.boolean(),
    bindings: z.record(shortcutCommandIdSchema, shortcutBindingSchema.nullable()),
    navigation: z.record(shortcutCommandIdSchema, navigationKey.nullable()),
  })
  .superRefine(({ bindings, navigation }, context) => {
    for (const [field, overrides] of [
      ['bindings', bindings],
      ['navigation', navigation],
    ] as const) {
      if (Object.keys(overrides).length > maxOverrides)
        context.addIssue({ code: 'custom', path: [field], message: 'TOO_MANY_OVERRIDES' });
    }
    const duplicates = new Set(
      platforms.flatMap((platform) => [
        ...conflictingIds(
          defaultBindings,
          bindings,
          (binding) => `${binding.code}:${bindingMask(binding.modifiers, platform)}`,
        ),
      ]),
    );
    for (const id of duplicates)
      context.addIssue({ code: 'custom', path: ['bindings', id], message: 'DUPLICATE_BINDING' });
    for (const id of conflictingIds(defaultNavigation, navigation, (key) => key))
      context.addIssue({
        code: 'custom',
        path: ['navigation', id],
        message: 'DUPLICATE_NAVIGATION',
      });
  });
export type ShortcutPreferences = z.infer<typeof shortcutPreferencesSchema>;

export function getShortcutBinding(
  preferences: ShortcutPreferences,
  id: string,
): ShortcutBinding | null {
  if (!preferences.enabled) return null;
  const override = ownValue(preferences.bindings, id);
  if (override !== undefined) return override;
  const binding = ownValue(defaultBindings, id);
  return binding ? { code: binding.code, modifiers: [...binding.modifiers] } : null;
}

export function getNavigationKey(preferences: ShortcutPreferences, id: string): string | null {
  if (!preferences.enabled) return null;
  const override = ownValue(preferences.navigation, id);
  return override === undefined ? (ownValue(defaultNavigation, id) ?? null) : override;
}

export function resolveShortcutBindings(preferences: ShortcutPreferences): Array<{
  commandId: string;
  binding: ShortcutBinding;
}> {
  if (!preferences.enabled) return [];
  const ids = new Set([...Object.keys(defaultBindings), ...Object.keys(preferences.bindings)]);
  return [...ids].flatMap((commandId) => {
    const binding = getShortcutBinding(preferences, commandId);
    return binding ? [{ commandId, binding }] : [];
  });
}

export function matchShortcut(
  input: ShortcutKeyInput,
  binding: ShortcutBinding,
  platform: ShortcutPlatform,
): boolean {
  if (
    input.code !== binding.code ||
    input.repeat ||
    input.isComposing ||
    input.defaultPrevented ||
    input.altGraph ||
    input.keyCode === 229 ||
    input.key === 'Dead' ||
    input.key === 'Process'
  )
    return false;
  const mask =
    (input.ctrlKey ? modifierMask.Control : 0) |
    (input.metaKey ? modifierMask.Meta : 0) |
    (input.altKey ? modifierMask.Alt : 0) |
    (input.shiftKey ? modifierMask.Shift : 0);
  return mask === bindingMask(binding.modifiers, platform);
}

const codeLabels: Record<string, string> = {
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};
const macLabels = { Control: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' } as const;
const otherLabels = { Control: 'Ctrl', Meta: 'Meta', Alt: 'Alt', Shift: 'Shift' } as const;
const macModifierOrder = ['Control', 'Alt', 'Shift', 'Meta'] as const;
const otherModifierOrder = ['Control', 'Meta', 'Alt', 'Shift'] as const;

export function formatShortcutBinding(
  binding: ShortcutBinding,
  platform: ShortcutPlatform,
): string {
  const labels = platform === 'mac' ? macLabels : otherLabels;
  const order = platform === 'mac' ? macModifierOrder : otherModifierOrder;
  const active = new Set(binding.modifiers.map((modifier) => physicalModifier(modifier, platform)));
  const label = ownValue(codeLabels, binding.code) ?? binding.code.replace(/^(?:Key|Digit)/u, '');
  return [...order.filter((key) => active.has(key)).map((key) => labels[key]), label].join(
    platform === 'mac' ? '' : '+',
  );
}

type KeyboardShortcutEvent = Pick<
  KeyboardEvent,
  | 'code'
  | 'key'
  | 'ctrlKey'
  | 'metaKey'
  | 'altKey'
  | 'shiftKey'
  | 'repeat'
  | 'isComposing'
  | 'keyCode'
  | 'getModifierState'
  | 'defaultPrevented'
>;

export function shortcutInputFromKeyboardEvent(event: KeyboardShortcutEvent): ShortcutKeyInput {
  return {
    code: event.code,
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    repeat: event.repeat,
    isComposing: event.isComposing,
    keyCode: event.keyCode,
    altGraph: event.getModifierState('AltGraph'),
    defaultPrevented: event.defaultPrevented,
  };
}
