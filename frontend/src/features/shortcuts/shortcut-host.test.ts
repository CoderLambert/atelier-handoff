/**
 * @file 验证快捷导航与配置在真实 Electron renderer 中的交互。
 * @implementation 使用隔离配置接口和宿主桥接替身覆盖焦点、模态、录制、失败重试及过期原生命令，独立宿主测试核对真实 IPC。
 * @updated 2026-11-26T22:00:00+08:00
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const execute = promisify(execFile);
const renderer = String.raw`
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { ShortcutHost, ShortcutSettings } from '@/features/shortcuts';
  import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
  import { uiI18n } from '@/i18n';
  const client = new QueryClient();
  void uiI18n.changeLanguage('en');
  window.registrations = [];
  const nativeListeners = new Set();
  window.atelierShortcuts = {
    async update(registration) { window.registrations.push(registration); },
    onCommand(listener) { nativeListeners.add(listener); return () => nativeListeners.delete(listener); },
  };
  window.deliverNative = (event) => nativeListeners.forEach(listener => listener(event));
  window.fixtureLocale = (locale) => uiI18n.changeLanguage(locale);
  function App() {
    const [settings, showSettings] = useState(false);
    const [modal, showModal] = useState(false);
    const [switcher, showSwitcher] = useState(false);
    const [left, setLeft] = useState(0);
    const [focused, setFocused] = useState(0);
    const [session, setSession] = useState('a');
    const commands = [
      { id:'layout.toggleLeft', label:'Toggle left sidebar', available:true, run:() => setLeft(value => value + 1) },
      { id:'layout.toggleRight', label:'Toggle right sidebar', available:false, run:() => { throw new Error('Disabled action ran'); } },
      { id:'composer.focus', label:'Focus conversation input', available:true, run:() => { setFocused(value => value + 1); document.getElementById('composer')?.focus(); } },
      { id:'sessions.switch', label:'Switch conversation', available:true, run:() => showModal(true) },
      { id:'shortcuts.settings', label:'Shortcuts', available:true, run:() => showSettings(true) },
    ];
    return <>
      <ShortcutHost commands={commands} contextKey={session} />
      <textarea id="composer" aria-label="Composer" />
      <output id="left-count">{left}</output><output id="focus-count">{focused}</output>
      <button id="settings-toggle" onClick={() => showSettings(value => !value)}>Settings toggle</button>
      <button id="modal-open" onClick={() => showModal(true)}>Open modal</button>
      <button id="switcher-open" onClick={() => showSwitcher(true)}>Open switcher</button>
      <button id="session-change" onClick={() => setSession(value => value === 'a' ? 'b' : 'a')}>Change context</button>
      {settings ? <ShortcutSettings /> : null}
      <Dialog open={modal} onOpenChange={showModal}>
        <DialogContent><DialogTitle>Business dialog</DialogTitle><DialogDescription>Existing modal</DialogDescription></DialogContent>
      </Dialog>
      <Dialog open={switcher} onOpenChange={showSwitcher}>
        <DialogContent data-shortcut-surface="switcher"><DialogTitle>Conversation switcher</DialogTitle><DialogDescription>Choose a conversation</DialogDescription>
          <input id="switcher-query" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); showSwitcher(false); } }} />
        </DialogContent>
      </Dialog>
    </>;
  }
  createRoot(document.getElementById('app')).render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
`;

const main = String.raw`
  import assert from 'node:assert/strict';
  import { app, BrowserWindow } from 'electron';
  import { createServer } from 'node:http';
  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { setTimeout as delay } from 'node:timers/promises';
  let preferences = { version:1, enabled:true, bindings:{}, navigation:{} };
  let saves = 0;
  const server = createServer((request, response) => {
    if (request.url === '/renderer.js' || request.url === '/renderer.css') {
      response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      response.end(readFileSync(join(__dirname, request.url.slice(1))));
    } else if (request.url === '/api/bootstrap') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ csrfToken:'fixture' }));
    } else if (request.url === '/api/settings/shortcuts') {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'PATCH') {
        let data = ''; request.on('data', chunk => data += chunk);
        request.on('end', () => {
          if (++saves === 1) { response.statusCode = 500; response.end(JSON.stringify({ error:{ message:'fixture save failure' } })); }
          else { preferences = JSON.parse(data); response.end(JSON.stringify(preferences)); }
        });
      } else response.end(JSON.stringify(preferences));
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<html><head><meta charset="utf-8"><link rel="stylesheet" href="/renderer.css"><style>'
        + ':root { --ui-border:#bbb; --ui-muted-foreground:#555; --ui-size-sm:32px; --text-xs:12px; }'
        + 'body{font-family:sans-serif;}button,input,textarea{font:inherit;}[role=dialog]{position:fixed;top:50px;left:100px;background:white;border:1px solid;width:650px;max-height:80vh;overflow:auto;padding:20px;z-index:50;}'
        + '.react-dialog-overlay{position:fixed;inset:0;background:#0004;}[hidden]{display:none;}'
        + '</style></head><body><div id="app"></div><script src="/renderer.js"></script></body></html>');
    }
  });
  async function until(label, check) {
    for (let attempt = 0; attempt < 80; attempt++) { if (await check()) return; await delay(20); }
    assert.fail(label + ' did not settle');
  }
  app.whenReady().then(async () => {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const window = new BrowserWindow({ width:1280, height:800, webPreferences:{ sandbox:true, contextIsolation:true } });
    const errors = [];
    window.webContents.on('console-message', event => { if (event.level === 'error' && !event.message.includes('Failed to load resource')) errors.push(event.message); });
    const read = async source => {
      try { return await window.webContents.executeJavaScript(source); }
      catch (error) { throw new Error('Renderer expression failed: ' + source + '\n' + errors.join('\n'), { cause:error }); }
    };
    const click = selector => read('document.querySelector(' + JSON.stringify(selector) + ').click()');
    const focus = selector => read('document.querySelector(' + JSON.stringify(selector) + ').focus()');
    const send = async (type, keyCode, modifiers = []) => { window.webContents.sendInputEvent({ type, keyCode, modifiers }); await delay(30); };
    const chord = async (keyCode, modifiers) => { await send('keyDown', keyCode, modifiers); await send('keyUp', keyCode, modifiers); };
    const navOpen = () => read('Boolean(document.querySelector("[data-shortcut-surface=navigator]"))');
    const text = selector => read('document.querySelector(' + JSON.stringify(selector) + ')?.textContent');
    const input = async (selector, value) => read('(() => { const element = document.querySelector(' + JSON.stringify(selector) + '); '
      + 'Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, ' + JSON.stringify(value) + '); '
      + 'element.dispatchEvent(new Event("input", {bubbles:true})); })()');
    await window.loadURL('http://127.0.0.1:' + server.address().port);
    await until('registered defaults', () => read('window.registrations?.at(-1)?.bindings.length === 2'));
    await focus('#composer');
    await chord(';', ['control','shift']);
    await until('navigation dialog', navOpen);
    assert.equal(await read('document.activeElement.textContent'), 'Toggle left sidebarH');
    await send('keyDown', 'I');
    await until('composer focused after navigation cleanup', () => read('document.activeElement.id === "composer" && document.getElementById("focus-count").textContent === "1"'));
    assert.equal(await read('(() => { const event = new KeyboardEvent("keydown", {key:"i",code:"KeyI",repeat:true,bubbles:true,cancelable:true}); document.activeElement.dispatchEvent(event); return event.defaultPrevented; })()'), true);
    await send('keyUp','I');
    assert.equal(await navOpen(), false);
    await chord(';', ['control','shift']);
    await until('keyboard navigation returns', navOpen);
    await chord('L');
    assert.equal(await navOpen(), true, 'unavailable navigation actions do not execute');
    await chord('Down');
    assert.equal(await read('document.activeElement.textContent'), 'Focus conversation inputI');
    await chord('Enter');
    await until('arrow and Enter action', async () => await text('#focus-count') === '2');

    await click('#modal-open');
    await until('ordinary modal suspends native commands', () => read('window.registrations.at(-1).bindings.length === 0'));
    await chord(';', ['control','shift']);
    assert.equal(await navOpen(), false);
    await chord('Escape');
    await until('ordinary modal closes', () => read('!document.querySelector("[role=dialog]")'));
    for (const [keyCode, key, code] of [['Enter','Enter','Enter'],['Escape','Escape','Escape']]) {
      await click('#switcher-open');
      await until('switcher opens', () => read('Boolean(document.querySelector("[data-shortcut-surface=switcher]"))'));
      await focus('#switcher-query');
      await send('keyDown', keyCode);
      await until('switcher handles its first closing key', () => read('!document.querySelector("[data-shortcut-surface=switcher]")'));
      assert.equal(await read('(() => { const event = new KeyboardEvent("keydown", ' + JSON.stringify({key,code,repeat:true,bubbles:true,cancelable:true}) + '); document.activeElement.dispatchEvent(event); return event.defaultPrevented; })()'), true);
      await send('keyUp', keyCode);
    }

    await click('#settings-toggle');
    await until('settings load', () => read('Boolean(document.querySelector(".shortcut-settings"))'));
    const recorder = '[aria-label="Direct shortcut for Toggle left sidebar"]';
    await focus(recorder); await click(recorder);
    await chord(';', ['control','shift']);
    await until('duplicate error', () => read('document.body.textContent.includes("This shortcut is assigned to another action.")'));
    assert.equal(await read('document.querySelector("button[type=submit]").disabled'), true);
    assert.equal(await navOpen(), false);
    await click(recorder);
    await chord('X', ['control','shift']);
    await until('custom candidate', () => read('document.querySelector(' + JSON.stringify(recorder) + ').textContent.includes("Ctrl+Shift+X")'));
    await input('[aria-label="Navigation key for Focus conversation input"]', 'U');
    await click('button[type=submit]');
    await until('save failure retains draft', () => read('document.body.textContent.includes("Save failed. Your changes are retained.")'));
    assert.equal(await read('document.querySelector(' + JSON.stringify(recorder) + ').textContent.includes("Ctrl+Shift+X")'), true);
    assert.equal(preferences.bindings['layout.toggleLeft'], undefined);
    await click('button[type=submit]');
    await until('save success', () => read('document.body.textContent.includes("Shortcuts saved.")'));
    assert.deepEqual(preferences.bindings['layout.toggleLeft'], {code:'KeyX',modifiers:['Mod','Shift']});
    assert.equal(preferences.navigation['composer.focus'], 'U');
    await click('#settings-toggle');
    await focus('#composer');
    await chord('X', ['control','shift']);
    await until('saved direct shortcut', async () => await text('#left-count') === '1');
    await chord(';', ['control','shift']);
    await until('navigation returns', navOpen);
    await chord('U');
    await until('saved navigation key', async () => await text('#focus-count') === '3');
    assert.equal(await read('document.activeElement.id'), 'composer');

    await until('native available after close', () => read('window.registrations.at(-1).bindings.length === 3'));
    const stale = await read('window.registrations.at(-1)');
    await click('#session-change');
    await until('context changes registration', () => read('window.registrations.at(-1).revision !== ' + JSON.stringify(stale.revision)));
    await read('window.deliverNative(' + JSON.stringify({revision:stale.revision,commandId:'layout.toggleLeft'}) + ')');
    assert.equal(await text('#left-count'), '1');
    await read('window.deliverNative({revision:window.registrations.at(-1).revision,commandId:"layout.toggleLeft"})');
    await until('current native command', async () => await text('#left-count') === '2');
    await read('void window.fixtureLocale("zh-CN")');
    await click('#settings-toggle');
    await until('Chinese settings', () => read('Boolean(document.querySelector(' + JSON.stringify('[aria-label="聚焦会话输入框的导航键"]') + '))'));
    assert.deepEqual(errors, []);
    console.log('shortcut renderer interaction passed');
    window.destroy(); server.close(); app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
`;

test(
  'shortcut renderer preserves focus and modal boundaries, saves configuration and rejects stale native commands',
  { skip: process.env.ATELIER_TEST_DESKTOP_SHORTCUTS !== '1', timeout: 35_000 },
  async () => {
    const require = createRequire(import.meta.url);
    const electron: unknown = require('electron');
    assert.ok(typeof electron === 'string');
    const directory = await mkdtemp(join(tmpdir(), 'atelier-shortcut-renderer-'));
    try {
      await Promise.all([
        build({
          absWorkingDir: root,
          stdin: { contents: renderer, resolveDir: root, loader: 'tsx' },
          tsconfig: join(root, 'frontend/tsconfig.json'),
          bundle: true,
          format: 'iife',
          platform: 'browser',
          outfile: join(directory, 'renderer.js'),
        }),
        build({
          stdin: { contents: main, resolveDir: root, loader: 'ts' },
          bundle: true,
          platform: 'node',
          external: ['electron'],
          format: 'cjs',
          outfile: join(directory, 'main.cjs'),
        }),
      ]);
      const result = await execute(
        electron,
        [
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          ...(process.platform === 'linux'
            ? ['--ozone-platform=headless', '--ozone-override-screen-size=2560,1440']
            : []),
          `--user-data-dir=${join(directory, 'profile')}`,
          join(directory, 'main.cjs'),
        ],
        { timeout: 30_000 },
      );
      assert.match(result.stdout, /shortcut renderer interaction passed/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
