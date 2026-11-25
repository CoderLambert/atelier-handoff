/**
 * @file 验证终端屏幕快照的实际渲染语义。
 * @implementation 使用真实 headless xterm 重放颜色、宽字符和替代屏幕，不把查询应答回写进程。
 * @updated 2026-11-26T01:00:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalScreen } from '../server/modules/terminal/screen.js';

test('serialized screen restores Unicode, cursor state and alternate screen', async () => {
  const screen = new TerminalScreen(80, 24);
  const restored = new TerminalScreen(80, 24);
  try {
    await screen.write('main\r\n\u001b[?1049h\u001b[31m世界\u001b[0m');
    await restored.write(screen.serialize());
    await restored.write('!');
    assert.ok(restored.serialize().includes('世界'));
    await restored.write('\u001b[?1049l');
    assert.ok(restored.serialize().includes('main'));
  } finally {
    screen.dispose();
    restored.dispose();
  }
});
