/**
 * @file 验证终端客户端的真实解析、连接和视图租约。
 * @implementation Chromium 使用真实 xterm 与回环 WebSocket，核对隐藏应答、主题切换、输出阻塞时的输入回执与连接恢复。
 * @updated 2026-11-26T01:00:00+08:00
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  terminalClientFrameSchema,
  type TerminalClientFrame,
  type TerminalRecord,
} from '../../../../shared/terminal';

const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));
const record: TerminalRecord = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  terminalId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  projectId: '44444444-4444-4444-8444-444444444444',
  workspaceId: null,
  initialCwd: '/fixture',
  shellName: 'bash',
  cols: 80,
  rows: 24,
  state: 'running',
  createdAt: '2026-11-25T00:00:00.000Z',
  exitCode: null,
  exitSignal: null,
};

test(
  'hidden terminals still answer queries and old view cleanup cannot detach a new lease',
  { skip: !browserPath, timeout: 30_000 },
  async (context) => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const built = await build({
      absWorkingDir: root,
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      tsconfig: `${root}/tsconfig.json`,
      stdin: {
        resolveDir: root,
        loader: 'ts',
        contents: `
      import {Terminal} from '@xterm/xterm';
      import {getTerminalClient, activateTerminalRuntime, disposeTerminalClients} from '@/features/terminal/terminal-client';
      const record=${JSON.stringify(record)};
      activateTerminalRuntime(record.runtimeId);
      const client=getTerminalClient(record, {receive(){},refreshRuntime(){}});
      let first, second, releaseWrite;
      const write=Terminal.prototype.write;
      Terminal.prototype.write=function(data, callback){
        if(data==='BLOCK_OUTPUT'){
          releaseWrite=()=>write.call(this,data,callback);
          return;
        }
        write.call(this,data,callback);
      };
      window.fixture={
        mount(){first=client.attachView(document.querySelector('#one'));},
        hide(){first?.release();},
        detach(){second?.release();},
        remount(){second=client.attachView(document.querySelector('#two'));},
        move(){second=client.attachView(document.querySelector('#two'));first?.release();},
        state(){return client.getSnapshot();},
        outputStalled(){return typeof releaseWrite==='function';},
        releaseOutput(){releaseWrite?.();releaseWrite=undefined;},
        reconnect(){client.reconnect();},
        dismissInputWarning(){client.acknowledgeInputWarning();},
        runtime(){activateTerminalRuntime('55555555-5555-4555-8555-555555555555');},
        dispose(){disposeTerminalClients();}
      };
    `,
      },
    });
    const bundle = built.outputFiles[0]?.text;
    assert.ok(bundle);
    const frames: TerminalClientFrame[] = [];
    const peers: WebSocket[] = [];
    let connections = 0;
    let seq = 0;
    let acknowledgeInput = true;
    const server = createServer((req, res) => {
      if (req.url === '/bundle.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return void res.end(bundle);
      }
      if (req.url === '/api/bootstrap') {
        res.setHeader('Content-Type', 'application/json');
        return void res.end(JSON.stringify({ csrfToken: 'fixture-token' }));
      }
      if (req.url?.endsWith('/attach-ticket')) {
        res.setHeader('Content-Type', 'application/json');
        return void res.end(
          JSON.stringify({
            runtimeId: record.runtimeId,
            ticket: 'a'.repeat(64),
            expiresAt: '2099-01-01T00:00:00.000Z',
            streamPath: '/api/terminals/stream',
            protocol: 'atelier-terminal.v1',
          }),
        );
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<style>${readFileSync(`${root}/../node_modules/@xterm/xterm/css/xterm.css`, 'utf8')} .viewport{width:800px;height:400px}.terminal-client{width:100%;height:100%;background:white;color:black} :root[data-theme="midnight"]{color-scheme:dark} :root[data-theme="midnight"] .terminal-client{background:#151b24;color:#e6edf3}</style><div id="one" class="viewport"></div><div id="two" class="viewport"></div><script src="/bundle.js"></script>`,
      );
    });
    const sockets = new WebSocketServer({ server, handleProtocols: () => 'atelier-terminal.v1' });
    context.after(async () => {
      for (const socket of peers) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    sockets.on('connection', (socket) => {
      connections++;
      peers.push(socket);
      const attachmentId =
        connections === 1
          ? '66666666-6666-4666-8666-666666666666'
          : '77777777-7777-4777-8777-777777777777';
      socket.send(
        JSON.stringify({
          type: 'snapshot',
          attachmentId,
          seq,
          screen: 'initial',
          terminal: record,
        }),
      );
      socket.on('message', (data) => {
        const frame = terminalClientFrameSchema.parse(JSON.parse(data.toString()));
        frames.push(frame);
        if (frame.type === 'ready')
          socket.send(
            JSON.stringify({
              type: 'readyAccepted',
              attachmentId,
              writable: true,
              terminal: record,
            }),
          );
        if (frame.type === 'input' && acknowledgeInput)
          socket.send(
            JSON.stringify({ type: 'inputAccepted', attachmentId, inputSeq: frame.inputSeq }),
          );
        if (frame.type === 'resize') {
          socket.send(
            JSON.stringify({
              type: 'resized',
              attachmentId,
              seq: ++seq,
              cols: frame.cols,
              rows: frame.rows,
            }),
          );
          socket.send(
            JSON.stringify({
              type: 'commandResult',
              attachmentId,
              commandSeq: frame.commandSeq,
              ok: true,
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const browser = await chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage();
    const waitFor = async (condition: () => boolean) => {
      for (let count = 0; count < 100 && !condition(); count++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(condition());
    };
    try {
      await page.goto(`http://127.0.0.1:${address.port}`);
      assert.equal(
        connections,
        0,
        'creating the cache entry must not connect before a measurable view',
      );
      await page.evaluate('window.fixture.mount()');
      await page.waitForFunction('window.fixture.state().phase === "connected"');
      await page.evaluate('window.fixture.move()');
      assert.equal(
        await page.locator('#two .xterm').count(),
        1,
        'old cleanup must not remove the moved terminal',
      );
      assert.equal(await page.locator('#one .xterm').count(), 0);
      assert.equal(connections, 1, 'view movement must reuse the connection');
      await page.evaluate('window.fixture.hide()');
      // Move replaced the first lease; hiding that old lease is intentionally harmless.
      await page.evaluate('window.fixture.detach()');
      let peer = peers.at(-1);
      assert.ok(peer);
      const firstPeer = peer;
      const sendOutput = (data: string) =>
        firstPeer.send(
          JSON.stringify({
            type: 'output',
            attachmentId: '66666666-6666-4666-8666-666666666666',
            seq: ++seq,
            data,
          }),
        );
      sendOutput('\x1b[6n');
      await waitFor(() =>
        frames.some(
          (frame) =>
            frame.type === 'input' &&
            frame.payload.encoding === 'utf8' &&
            /^\x1b\[\d+;\d+R$/u.test(frame.payload.data),
        ),
      );
      assert.equal(
        frames.filter((frame) => frame.type === 'input').length,
        1,
        'exactly one renderer responds to the query',
      );
      await waitFor(() => frames.some((frame) => frame.type === 'outputAck' && frame.seq === seq));
      await page.evaluate('window.fixture.remount()');
      // Transparent-background editors can emit RGB foreground colors outside the ANSI palette.
      sendOutput('\r\n\x1b[38;2;198;208;245mPALE_TEXT\x1b[0m');
      const paleText = page
        .locator('#two .xterm-rows span')
        .getByText('PALE_TEXT', { exact: true });
      await paleText.waitFor({ timeout: 3000 });
      assert.notEqual(
        await paleText.evaluate((element) => getComputedStyle(element).color),
        'rgb(198, 208, 245)',
        'Pale truecolor text on the light terminal is adjusted for contrast',
      );
      sendOutput('\r\n\x1b[32mANSI_GREEN\x1b[0m');
      const ansiGreen = page
        .locator('#two .xterm-rows span')
        .getByText('ANSI_GREEN', { exact: true });
      await ansiGreen.waitFor({ timeout: 3000 });
      assert.equal(
        await ansiGreen.evaluate((element) => getComputedStyle(element).color),
        'rgb(17, 99, 41)',
      );
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'midnight';
      });
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('#two .xterm-rows span')).some(
            (element) =>
              element.textContent?.includes('ANSI_GREEN') &&
              getComputedStyle(element).color === 'rgb(13, 188, 121)',
          ),
        undefined,
        { timeout: 3000 },
      );
      assert.equal(connections, 1, 'Theme changes keep the existing terminal connection');
      sendOutput('BLOCK_OUTPUT');
      await page.waitForFunction('window.fixture.outputStalled()');
      await page.locator('#two .xterm-helper-textarea').fill('accepted-while-renderer-busy');
      await waitFor(() =>
        frames.some(
          (frame) =>
            frame.type === 'input' &&
            frame.payload.encoding === 'utf8' &&
            frame.payload.data.includes('accepted-while-renderer-busy'),
        ),
      );
      // TCP preserves the receipt ahead of the orderly close, while the xterm write still waits.
      peer.close(4000);
      await page.waitForFunction('window.fixture.state().phase === "disconnected"');
      assert.equal(
        await page.evaluate('window.fixture.state().inputUnconfirmed'),
        false,
        'A received input receipt is accounted for even if xterm is still processing output',
      );
      await page.evaluate('window.fixture.releaseOutput()');
      await page.evaluate('window.fixture.reconnect()');
      await page.waitForFunction('window.fixture.state().phase === "connected"');
      peer = peers.at(-1);
      assert.ok(peer);
      const inputCount = frames.filter((frame) => frame.type === 'input').length;
      acknowledgeInput = false;
      await page.locator('#two .xterm-helper-textarea').fill('unconfirmed');
      await page.locator('#two .xterm-helper-textarea').press('Enter');
      await waitFor(() => frames.filter((frame) => frame.type === 'input').length > inputCount);
      peer.terminate();
      await page.waitForFunction('window.fixture.state().inputUnconfirmed === true');
      await page.evaluate('window.fixture.dismissInputWarning()');
      await page.evaluate('window.fixture.reconnect()');
      await page.waitForFunction('window.fixture.state().phase === "connected"');
      assert.equal(await page.evaluate('window.fixture.state().inputUnconfirmed'), false);
      assert.ok(connections >= 2);
      const countAfterReconnect = frames.filter((frame) => frame.type === 'input').length;
      await page.waitForTimeout(80);
      assert.equal(
        frames.filter((frame) => frame.type === 'input').length,
        countAfterReconnect,
        'unconfirmed input is never replayed',
      );
      await page.evaluate('window.fixture.runtime()');
      assert.equal(
        await page.locator('.xterm').count(),
        0,
        'runtime replacement disposes the emulator',
      );
      await waitFor(() => peers.every((socket) => socket.readyState >= 2));
    } finally {
      await page.evaluate('window.fixture?.dispose()').catch(() => {});
      await browser.close();
    }
  },
);
