/**
 * @file 验证桌面工作台快捷键 IPC 和原生网页的键盘归属。
 * @implementation 使用隔离 Electron 窗口和实际 preload 验证可信注册、焦点交还及按键透传。
 * @updated 2026-11-26T21:35:00+08:00
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { desktopShortcutRegistrationSchema } from '../shared/desktop-shortcuts.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

test('desktop shortcut registrations are bounded and exclude duplicate commands', () => {
  const binding = { code: 'KeyK', modifiers: ['Control', 'Shift'] };
  const command = { commandId: 'composer.focus', binding };
  const valid = { revision: 'renderer-1', bindings: [command] };
  assert.deepEqual(desktopShortcutRegistrationSchema.parse(valid), valid);
  for (const invalid of [
    { ...valid, revision: 'renderer/next' },
    { ...valid, bindings: [{ ...command, commandId: '__proto__' }] },
    { ...valid, bindings: [command, command] },
    {
      ...valid,
      bindings: Array.from({ length: 33 }, (_, index) => ({
        ...command,
        commandId: 'test.command' + index,
      })),
    },
    {
      ...valid,
      bindings: [{ ...command, binding: { ...binding, modifiers: ['Control', 'Alt'] } }],
    },
  ]) {
    assert.equal(desktopShortcutRegistrationSchema.safeParse(invalid).success, false);
  }
});

test(
  'desktop shortcuts register from the trusted renderer and route native keys safely',
  { skip: process.env.ATELIER_TEST_DESKTOP_SHORTCUTS !== '1' },
  async () => {
    const require = createRequire(import.meta.url);
    const electron: unknown = require('electron');
    assert.ok(typeof electron === 'string');
    const directory = await mkdtemp(join(tmpdir(), 'atelier-desktop-shortcuts-'));
    try {
      await Promise.all([
        build({
          absWorkingDir: root,
          entryPoints: ['desktop/preload.cts'],
          outfile: join(directory, 'preload.cjs'),
          bundle: true,
          platform: 'node',
          external: ['electron'],
          format: 'cjs',
        }),
        build({
          absWorkingDir: root,
          entryPoints: ['tests/fixtures/desktop-shortcuts-app.ts'],
          outfile: join(directory, 'main.cjs'),
          bundle: true,
          platform: 'node',
          external: ['electron'],
          format: 'cjs',
        }),
      ]);
      await run(
        electron,
        [
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          ...(process.platform === 'linux'
            ? ['--ozone-platform=headless', '--ozone-override-screen-size=1280,800']
            : []),
          `--user-data-dir=${join(directory, 'profile')}`,
          join(directory, 'main.cjs'),
        ],
        { timeout: 25_000 },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
