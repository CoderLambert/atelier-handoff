/**
 * @file 在隔离 Electron 中验证工作台快捷键与网页控制权。
 * @implementation 使用实际主进程、preload 和本地网页，核对信道、焦点、注册生命周期、网页键盘事件及 Agent 输入。
 * @updated 2026-11-27T22:00:00+08:00
 */
import assert from 'node:assert/strict';
import {
  app,
  BrowserWindow,
  WebContentsView,
  type KeyboardInputEvent,
  type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { createBrowserController } from '../../desktop/browser/controller.mjs';
import { createDesktopShortcuts } from '../../desktop/shortcuts.mjs';
import {
  desktopBrowserProtocolVersion,
  type DesktopBrowserAction,
  type DesktopBrowserCall,
  type DesktopBrowserLayout,
} from '../../shared/desktop-browser.js';
import { desktopShortcutChannels } from '../../shared/desktop-shortcuts.js';

async function serve(page: string) {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(page);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function until(label: string, check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(`${label} did not settle`);
}

const page =
  '<input id="field" aria-label="Input"><script>' +
  'window.keys = []; window.commands = []; ' +
  'for (const type of ["keydown", "keyup"]) window.addEventListener(type, e => { ' +
  'if (e.code === "KeyK" || e.code === "KeyX") window.keys.push(type + ":" + e.code); }); ' +
  '</script>';

app
  .whenReady()
  .then(async () => {
    const workbench = await serve(page);
    const website = await serve(page);
    const webPreferences = {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
    };
    const owner = new BrowserWindow({
      width: 800,
      height: 600,
      useContentSize: true,
      webPreferences,
    });
    const host = { getWindow: () => owner, getOrigin: () => workbench, isStopping: () => false };
    const nativeShortcuts = createDesktopShortcuts(host);
    const detach = nativeShortcuts.attachWindow(owner);
    const unbind = nativeShortcuts.bindIpc();
    const browser = createBrowserController({
      ...host,
      onShortcutInput: nativeShortcuts.handleGuestInput,
    });
    const unbindBrowser = browser.bindIpc();
    const projectId = randomUUID();
    const project = JSON.stringify(projectId);
    const read = (source: string): Promise<unknown> => owner.webContents.executeJavaScript(source);
    const command = (action: DesktopBrowserAction, value?: string) =>
      read(
        'window.atelierDesktop.command(' +
          [projectId, action, value].map((item) => JSON.stringify(item) ?? 'undefined').join(',') +
          ')',
      );
    const register = (revision: string) =>
      'window.atelierShortcuts.update(' +
      JSON.stringify({
        revision,
        bindings: [
          {
            commandId: 'composer.focus',
            binding: { code: 'KeyK', modifiers: ['Control', 'Shift'] },
          },
        ],
      }) +
      ')';
    const watch = () =>
      read(
        'void (window.removeShortcutListener = window.atelierShortcuts.onCommand(event => {' +
          'window.commands.push({...event, focused: document.hasFocus()}); }))',
      );
    const bounds = { x: 400, y: 0, width: 380, height: 500 };
    const arrange = (layout: DesktopBrowserLayout['bounds']) =>
      read('window.atelierDesktop.layout(' + project + ',' + JSON.stringify(layout) + ')');
    const guestView = () =>
      owner.contentView.children.find(
        (view): view is WebContentsView =>
          view instanceof WebContentsView && view.webContents !== owner.webContents,
      );
    const send = async (
      contents: WebContents,
      type: 'keyDown' | 'keyUp',
      keyCode: string,
      modifiers: NonNullable<KeyboardInputEvent['modifiers']> = [],
    ) => {
      contents.sendInputEvent({ type, keyCode, modifiers });
      await delay(40);
    };

    await owner.loadURL(workbench);
    const available = await read(
      "typeof window.atelierShortcuts?.update === 'function' && typeof window.atelierShortcuts?.onCommand === 'function'",
    );
    assert.equal(available, true, 'trusted renderer exposes the narrow shortcut bridge');
    await watch();
    await read(register('renderer-1'));
    await read("history.pushState({}, '', '/same-document')");
    owner.webContents.send(desktopShortcutChannels.command, {
      revision: 'renderer-1',
      commandId: 'composer.focus',
      unexpected: true,
    });

    const rogue = new BrowserWindow({ show: false, webPreferences });
    await rogue.loadURL(workbench);
    await assert.rejects(rogue.webContents.executeJavaScript(register('wrong-window')));
    rogue.destroy();

    await arrange(bounds);
    await until('native view attach', () => Boolean(guestView()));
    await command('navigate', website);
    const guest = guestView()?.webContents;
    assert.ok(guest);
    assert.equal(await guest.executeJavaScript('typeof window.atelierShortcuts'), 'undefined');
    owner.focus();
    guest.focus();
    assert.equal(guest.isFocused(), true);

    await send(guest, 'keyDown', 'X');
    await send(guest, 'keyDown', 'K', ['control', 'shift', 'isautorepeat']);
    assert.deepEqual(await guest.executeJavaScript('window.keys'), [
      'keydown:KeyX',
      'keydown:KeyK',
    ]);
    assert.deepEqual(await read('window.commands'), []);
    await send(guest, 'keyDown', 'K', ['control', 'shift']);
    await until(
      'shortcut command delivery',
      async () => (await read('window.commands.length')) === 1,
    );
    assert.deepEqual(await read('window.commands'), [
      { revision: 'renderer-1', commandId: 'composer.focus', focused: true },
    ]);
    assert.deepEqual(await guest.executeJavaScript('window.keys'), [
      'keydown:KeyX',
      'keydown:KeyK',
    ]);

    await send(owner.webContents, 'keyDown', 'K', ['isautorepeat']);
    await send(owner.webContents, 'keyUp', 'K');
    assert.deepEqual(await read('window.keys'), []);
    await send(owner.webContents, 'keyDown', 'K');
    assert.deepEqual(await read('window.keys'), ['keydown:KeyK']);
    await read('window.atelierShortcuts.update({ revision: "inactive", bindings: [] })');
    guest.focus();
    await send(guest, 'keyDown', 'K', ['control', 'shift']);
    assert.equal(await read('window.commands.length'), 1);
    assert.deepEqual(await guest.executeJavaScript('window.keys'), [
      'keydown:KeyX',
      'keydown:KeyK',
      'keydown:KeyK',
    ]);
    await read(register('renderer-1-active'));

    guest.focus();
    await arrange(null);
    await until('native view detach', () => !guestView());
    assert.equal(
      owner.webContents.isFocused(),
      true,
      'hiding the focused native view restores workbench input',
    );
    await arrange(bounds);
    await until('native view reattach', () => Boolean(guestView()));
    assert.equal(guestView()?.webContents, guest);

    await owner.loadURL(workbench + '/reload');
    await watch();
    guest.focus();
    await send(guest, 'keyDown', 'K', ['control', 'shift']);
    assert.deepEqual(await read('window.commands'), []);
    assert.deepEqual(await guest.executeJavaScript('window.keys'), [
      'keydown:KeyX',
      'keydown:KeyK',
      'keydown:KeyK',
      'keydown:KeyK',
    ]);
    await read(register('renderer-2'));

    const request: Omit<DesktopBrowserCall, 'name' | 'args' | 'id'> = {
      type: 'desktop-browser-call',
      protocolVersion: desktopBrowserProtocolVersion,
      projectId,
      runId: randomUUID(),
      allowedOrigins: [website],
    };
    const snapshot = () =>
      browser.runTool({ ...request, id: randomUUID(), name: 'browser_snapshot', args: {} });
    await assert.rejects(snapshot(), /浏览器由用户控制/u);
    await command('release');
    const result = await snapshot();
    assert.ok(result.text);
    const target = /-\s+textbox\s+"Input"\s+\[ref=(r[1-9]\d*-[1-9]\d*)\]/.exec(result.text)?.[1];
    assert.ok(target);
    await browser.runTool({
      ...request,
      id: randomUUID(),
      name: 'browser_type',
      args: { target, text: 'agent-owned input' },
    });
    assert.equal(
      await guest.executeJavaScript("document.querySelector('#field').value"),
      'agent-owned input',
    );
    assert.deepEqual(await read('window.commands'), []);

    await owner.loadURL(website);
    await assert.rejects(read(register('wrong-origin')));
    browser.reset();
    unbindBrowser();
    detach();
    unbind();
    owner.destroy();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
