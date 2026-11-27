/**
 * @file 提供跨平台 CDP 键盘事件映射与修饰键位掩码计算。
 * @implementation 统一常用功能键、方向键、字母数字与修饰键的 CDP 描述，并按运行平台选择全选快捷键。
 * @updated 2026-11-27T23:30:00+08:00
 */

export type KeyModifier = 'Control' | 'Shift' | 'Alt' | 'Meta';

export interface KeyDescriptor {
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
  readonly text?: string;
}

const MODIFIER_BITS: Readonly<Record<KeyModifier, number>> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

const NAMED_KEYS: Readonly<Record<string, KeyDescriptor>> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  F1: { key: 'F1', code: 'F1', windowsVirtualKeyCode: 112 },
  F2: { key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 },
  F3: { key: 'F3', code: 'F3', windowsVirtualKeyCode: 114 },
  F4: { key: 'F4', code: 'F4', windowsVirtualKeyCode: 115 },
  F5: { key: 'F5', code: 'F5', windowsVirtualKeyCode: 116 },
  F6: { key: 'F6', code: 'F6', windowsVirtualKeyCode: 117 },
  F7: { key: 'F7', code: 'F7', windowsVirtualKeyCode: 118 },
  F8: { key: 'F8', code: 'F8', windowsVirtualKeyCode: 119 },
  F9: { key: 'F9', code: 'F9', windowsVirtualKeyCode: 120 },
  F10: { key: 'F10', code: 'F10', windowsVirtualKeyCode: 121 },
  F11: { key: 'F11', code: 'F11', windowsVirtualKeyCode: 122 },
  F12: { key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 },
};

export function modifiersBitmask(modifiers?: readonly KeyModifier[]): number {
  if (!modifiers || modifiers.length === 0) return 0;
  let mask = 0;
  for (const mod of modifiers) {
    mask |= MODIFIER_BITS[mod];
  }
  return mask;
}

export function selectAllModifiers(platform: NodeJS.Platform = process.platform): readonly KeyModifier[] {
  return platform === 'darwin' ? ['Meta'] : ['Control'];
}

export function resolveKeyDescriptor(rawKey: string): KeyDescriptor {
  const named = NAMED_KEYS[rawKey];
  if (named) return named;

  if (rawKey.length === 1) {
    const ch = rawKey;
    const upper = ch.toUpperCase();
    const codePoint = upper.charCodeAt(0);
    if (codePoint >= 65 && codePoint <= 90) {
      return {
        key: ch,
        code: `Key${upper}`,
        windowsVirtualKeyCode: codePoint,
        text: ch,
      };
    }
    if (codePoint >= 48 && codePoint <= 57) {
      return {
        key: ch,
        code: `Digit${ch}`,
        windowsVirtualKeyCode: codePoint,
        text: ch,
      };
    }
    return {
      key: ch,
      code: '',
      windowsVirtualKeyCode: ch.charCodeAt(0),
      text: ch,
    };
  }

  throw new Error(`不支持的按键名称：${rawKey}`);
}
