/**
 * @file 为 xterm 解析工作台主题及 ANSI 色板。
 * @implementation 参考 Oh-DSH 终端的亮暗色板，将工作台的表面、文字和选区颜色映射到 xterm。
 * @updated 2026-11-26T13:05:00+08:00
 */
import type { ITheme } from '@xterm/xterm';

/*!
 * ANSI palette from Oh-DSH, plugins/panel-controls/src/terminal/terminal-theme.ts.
 *
 * MIT License
 *
 * Copyright (c) 2026 Oh-DSH contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const lightAnsi = {
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#bf3989',
  brightCyan: '#3192aa',
  brightWhite: '#afb8c1',
} satisfies ITheme;

const darkAnsi = {
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
} satisfies ITheme;

export function resolveTerminalTheme(container: HTMLElement): ITheme {
  const style = getComputedStyle(container);
  return {
    ...(style.colorScheme === 'dark' ? darkAnsi : lightAnsi),
    background: style.backgroundColor,
    foreground: style.color,
    cursor: style.color,
    cursorAccent: style.backgroundColor,
    selectionBackground: style.getPropertyValue('--ui-selected').trim() || undefined,
    selectionForeground: style.getPropertyValue('--ui-selected-foreground').trim() || undefined,
  };
}
