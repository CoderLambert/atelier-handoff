/**
 * @file 验证原生文件 IPC 在关停时拒绝工作台请求。
 * @implementation 替换 Electron 对话框和 IPC 注册，模拟可信主 frame 并确认关停前后对话框调用次数。
 * @updated 2026-11-27T16:55:00+08:00
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { desktopFilesChannels } from '../shared/desktop-files.js';

test('native directory picker rejects a trusted renderer when the host is stopping', async () => {
  const electron =
    'data:text/javascript,' +
    encodeURIComponent(`
    export const handlers = new Map();
    export const openCalls = [];
    export const app = {};
    export const shell = {};
    export const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
    export const dialog = {
      showOpenDialog(owner) {
        openCalls.push(owner);
        return Promise.resolve({ canceled: false, filePaths: ['/fixture'] });
      },
    };
  `);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'electron') return { url: electron, shortCircuit: true };
      return next(specifier, context);
    },
  });
  try {
    const {
      handlers,
      openCalls,
    }: {
      handlers: Map<string, (event: unknown) => Promise<unknown>>;
      openCalls: unknown[];
    } = await import(electron);
    const { createNativeFileActions } = await import('../desktop/host/files.mjs');
    const connection = { origin: 'http://127.0.0.1:3000', pairing: 'fixture' };
    const mainFrame = { origin: connection.origin };
    const webContents = { mainFrame, isDestroyed: () => false };
    const owner = { webContents, isDestroyed: () => false };
    let stopping = false;
    Reflect.apply(createNativeFileActions, undefined, [
      () => owner,
      () => connection,
      () => stopping,
    ]);

    const pickDirectory = handlers.get(desktopFilesChannels.pickDirectory);
    assert.ok(pickDirectory);
    const event = { sender: webContents, senderFrame: mainFrame };
    assert.equal(await pickDirectory(event), '/fixture');
    await assert.rejects(pickDirectory({ ...event, senderFrame: { origin: connection.origin } }));
    const openBeforeShutdown = pickDirectory(event);
    stopping = true;
    await assert.rejects(openBeforeShutdown);
    await assert.rejects(pickDirectory(event));
    assert.deepEqual(openCalls, [owner, owner]);
  } finally {
    hooks.deregister();
  }
});
