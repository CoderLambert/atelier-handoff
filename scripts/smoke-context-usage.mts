/**
 * @file 验证 Electron 会话、上下文详情和工作台布局。
 * @implementation 用隔离 profile 与回环模型覆盖草稿、键盘导航、界面语言、原生网页和多尺寸截图。
 * @updated 2026-11-23T05:06:46+08:00
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { sendModelReply } from '../tests/fixtures/subagent-gateway.js';
import { until } from './p1-smoke/contracts.mjs';

const directory = await mkdtemp(join(tmpdir(), 'atelier-context-usage-'));
const project = join(directory, 'project');
const model = 'fixture-context-window';
const webTitle = 'Context UI fixture with a long browser tab title';
const requests: string[] = [];
const gateway = createServer(async (request, response) => {
  if (request.method === 'GET') {
    if (request.url === '/fixture-browser') {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<!doctype html><title>${webTitle}</title><h1>${webTitle}</h1><label>Fixture input <input></label>`,
      );
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/routes' ? { data: [{ model }] } : {}));
    return;
  }
  requests.push(request.url ?? '');
  for await (const _ of request) {
    // Drain the request before returning the synthetic response.
  }
  if (!request.url?.startsWith('/v1/messages') || request.url.includes('/count_tokens')) {
    response.writeHead(404).end();
    return;
  }
  sendModelReply(response, model, 'Context fixture completed.', {
    input_tokens: 2500,
    output_tokens: 200,
    cache_creation_input_tokens: 1500,
    cache_read_input_tokens: 6000,
  });
});
let app: ElectronApplication | undefined;

async function setSize(page: Page, width: number, height: number) {
  await app?.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(width, height);
    },
    { width, height },
  );
  await page.setViewportSize({ width, height });
  await page.waitForFunction(
    ({ width, height }) => innerWidth === width && innerHeight === height,
    { width, height },
  );
}

async function verifyPanel(page: Page, title: string, cacheLabel: string) {
  const button = page.getByRole('button', { name: title, exact: true });
  await button.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: title });
  await panel.getByText(cacheLabel, { exact: true }).waitFor();
  const cacheRow = panel
    .locator('dl > div')
    .filter({ has: page.getByText(cacheLabel, { exact: true }) });
  assert.equal(await cacheRow.locator('dd').first().innerText(), '60%');
  assert.ok(await panel.getByText(model, { exact: false }).count());
  const bounds = await panel.boundingBox();
  assert.ok(bounds);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(bounds.x >= 0 && bounds.y >= 0);
  assert.ok(
    bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height,
  );
  return { button, panel, viewport };
}

try {
  await mkdir(project);
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  const launch = () =>
    _electron.launch({
      executablePath: resolve('node_modules/electron/dist/electron'),
      args: [
        resolve('dist/desktop/main.mjs'),
        `--user-data-dir=${join(directory, 'profile')}`,
        '--disable-gpu',
      ],
      env: {
        ...process.env,
        ATELIER_DATA_DIR: join(directory, 'data'),
        ATELIER_PORT: '0',
        ATELIER_GATEWAY: `http://127.0.0.1:${address.port}`,
        ATELIER_MODEL: model,
        ATELIER_NATIVE_EXECUTION: '1',
        ATELIER_MAGPIE_URL: '',
      },
      timeout: 25_000,
    });
  app = await launch();
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const bind = page.getByRole('dialog', { name: '绑定项目目录' });
  await bind.getByLabel('本机目录').fill(project);
  await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
  await bind.waitFor({ state: 'hidden' });
  await setSize(page, 1280, 800);
  await page.getByRole('button', { name: '上下文详情', exact: true }).click();
  await page.getByText('暂无上下文用量。发送一条任务后可查看。', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(requests.length, 0);
  const input = page.locator('#prompt-input');
  await input.fill('W'.repeat(50) + ' Test long session title.');
  await input.press('Enter');
  await page.getByText('Context fixture completed.', { exact: true }).first().waitFor();
  await page.waitForFunction(() =>
    document.querySelector('button[aria-label="上下文详情"]')?.textContent?.includes('%'),
  );
  const chatHash = new URL(page.url()).hash;
  assert.ok(chatHash.includes('session'));
  await input.fill('Preserve this draft.');
  const first = await verifyPanel(page, '上下文详情', '缓存命中率');
  await first.panel.getByText('内置工具', { exact: true }).waitFor();
  await first.panel.getByText('压缩预留', { exact: true }).waitFor();
  await first.panel.locator('summary').filter({ hasText: '请求用量明细' }).click();
  await first.panel.getByText('缓存读取', { exact: true }).waitFor();
  await first.panel.locator('summary').filter({ hasText: '请求用量明细' }).click();
  await first.panel.getByText('缓存读取', { exact: true }).waitFor({ state: 'hidden' });
  if (process.env.ATELIER_CONTEXT_SCREENSHOT)
    await page.screenshot({ path: process.env.ATELIER_CONTEXT_SCREENSHOT });
  await page.keyboard.press('Escape');
  await first.panel.waitFor({ state: 'hidden' });
  await until(
    async () =>
      (await first.button.evaluate((element) => document.activeElement === element)) || undefined,
    2_000,
    'context trigger regains focus after Escape',
  );
  assert.equal(await input.inputValue(), 'Preserve this draft.');
  await page.getByRole('button', { name: '浏览器', exact: true }).click();
  const browser = page.locator('.desktop-browser');
  const title = page.locator('.session-title-row h1');
  await title.waitFor();
  assert.ok(
    await title.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        style.whiteSpace === 'nowrap' &&
        style.textOverflow === 'ellipsis' &&
        element.scrollWidth > element.clientWidth
      );
    }),
  );
  assert.equal(await title.getAttribute('title'), await title.textContent());
  await browser.getByRole('button', { name: '新建标签页', exact: true }).click();
  const webAddress = browser.getByRole('textbox', { name: '网页地址', exact: true });
  const webUrl = `http://127.0.0.1:${address.port}/fixture-browser`;
  await webAddress.fill(webUrl);
  await webAddress.press('Enter');
  const tabTitle = browser.locator('.desktop-browser-tab-title').filter({ hasText: webTitle });
  await tabTitle.waitFor();
  assert.ok(
    await tabTitle.evaluate(
      (element) =>
        getComputedStyle(element).textOverflow === 'ellipsis' &&
        element.scrollWidth > element.clientWidth,
    ),
  );
  assert.ok((await webAddress.boundingBox())?.width);
  const layout = await page.locator('#conversation').evaluate((element) => ({
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
  const send = await page.getByRole('button', { name: '发送任务', exact: true }).boundingBox();
  const rightPanel = await browser.boundingBox();
  assert.ok(send && rightPanel && send.x + send.width <= rightPanel.x);
  const centerToolbar = await page.locator('.topbar').boundingBox();
  const browserTabs = await browser.locator('.desktop-browser-tabbar').boundingBox();
  assert.ok(centerToolbar && browserTabs);
  assert.equal(centerToolbar.height, 48);
  assert.equal(browserTabs.height, 48);
  assert.equal(centerToolbar.y + centerToolbar.height, browserTabs.y + browserTabs.height);
  const nativeTabAttached = () =>
    app?.evaluate(
      ({ BrowserWindow, WebContentsView }, url) =>
        BrowserWindow.getAllWindows()[0]?.contentView.children.some(
          (view) => view instanceof WebContentsView && view.webContents.getURL() === url,
        ),
      webUrl,
    );
  await until(
    async () => ((await nativeTabAttached()) === true ? true : undefined),
    5_000,
    'native page in the sidebar',
  );
  const native = await until(
    async () =>
      app
        ?.context()
        .pages()
        .find((candidate) => candidate.url() === webUrl),
    5_000,
    'native browser target',
  );
  const webInput = native.getByRole('textbox', { name: 'Fixture input' });
  await webInput.pressSequentially('local input');
  assert.equal(await webInput.inputValue(), 'local input');

  const splitter = page.getByRole('separator', { name: '调整右侧工具宽度' });
  const originalWidth = await native.evaluate(() => innerWidth);
  await splitter.press('ArrowLeft');
  const wider = await until(
    async () => {
      const width = await native.evaluate(() => innerWidth);
      const bounds = await browser.locator('.desktop-browser-slot').boundingBox();
      return bounds && width > originalWidth + 2 && Math.abs(bounds.width - width) <= 2
        ? width
        : undefined;
    },
    5_000,
    'native viewport follows splitter keyboard changes',
  );
  const grip = await splitter.boundingBox();
  assert.ok(grip);
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 40, grip.y + grip.height / 2, { steps: 4 });
  await page.mouse.up();
  await until(
    async () => {
      const width = await native.evaluate(() => innerWidth);
      const bounds = await browser.locator('.desktop-browser-slot').boundingBox();
      return bounds && width < wider - 2 && Math.abs(bounds.width - width) <= 2 ? width : undefined;
    },
    5_000,
    'native viewport follows splitter drag',
  );
  if (process.env.ATELIER_BROWSER_SCREENSHOT)
    await page.screenshot({ path: process.env.ATELIER_BROWSER_SCREENSHOT });
  for (const [trigger, title] of [
    ['变更记录', '变更记录'],
    ['浏览器设置', '浏览器设置'],
  ] as const) {
    const open = page.getByRole('button', { name: trigger, exact: true });
    await open.click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await dialog.waitFor();
    if (title === '变更记录') {
      const drawer = await dialog.boundingBox();
      assert.ok(drawer);
      assert.equal(drawer.y, 0);
      assert.equal(drawer.x + drawer.width, await page.evaluate(() => innerWidth));
    }
    await until(
      async () => ((await nativeTabAttached()) === false ? true : undefined),
      5_000,
      `native page detached under ${title}`,
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await until(
      async () => ((await nativeTabAttached()) === true ? true : undefined),
      5_000,
      `native page restored after ${title}`,
    );
    await until(
      async () =>
        (await open.evaluate((element) => document.activeElement === element)) || undefined,
      2_000,
      `trigger regains focus after ${title}`,
    );
  }
  const overBrowser = await verifyPanel(page, '上下文详情', '缓存命中率');
  await until(
    async () => ((await nativeTabAttached()) === false ? true : undefined),
    5_000,
    'native page detached under the popover',
  );
  await page.keyboard.press('Escape');
  await overBrowser.panel.waitFor({ state: 'hidden' });
  await until(
    async () => ((await nativeTabAttached()) === true ? true : undefined),
    5_000,
    'native page restored',
  );
  const previousTab = browser.locator('.desktop-browser-tab[data-active="false"]').first();
  await previousTab.locator('.desktop-browser-tab-select').click();
  await until(
    async () => ((await nativeTabAttached()) === false ? true : undefined),
    5_000,
    'switching tabs detaches the previous native page',
  );
  await browser.locator('.desktop-browser-tab[data-active="true"] .desktop-browser-icon').click();
  await until(
    async () => ((await nativeTabAttached()) === true ? true : undefined),
    5_000,
    'closing the active tab restores the remaining native page',
  );
  await until(
    async () =>
      (await browser
        .locator('.desktop-browser-tab-select')
        .first()
        .evaluate((element) => element === document.activeElement)) || undefined,
    2_000,
    'tab close returns focus to the remaining tab',
  );
  await page.getByRole('button', { name: '收起浏览器面板', exact: true }).click();
  await browser.waitFor({ state: 'hidden' });
  await until(
    async () =>
      (await page
        .getByRole('button', { name: '浏览器', exact: true })
        .evaluate((element) => element === document.activeElement)) || undefined,
    2_000,
    'panel close returns focus to the workspace browser trigger',
  );
  await page.goto(`${new URL(page.url()).origin}/#/settings/models`);
  await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await app.close();
  app = await launch();
  const reopened = await app.firstWindow();
  reopened.setDefaultTimeout(15_000);
  await reopened.waitForURL('http://127.0.0.1:*/**');
  await reopened.goto(`${new URL(reopened.url()).origin}/${chatHash}`);
  await setSize(reopened, 1440, 900);
  const second = await verifyPanel(reopened, 'Context details', 'Cache hit rate');
  await second.panel.getByText('Built-in tools', { exact: true }).waitFor();
  await reopened.mouse.click(12, 12);
  await second.panel.waitFor({ state: 'hidden' });
  assert.equal(await reopened.locator('#prompt-input').inputValue(), 'Preserve this draft.');

  const tabs = reopened.getByRole('tab');
  await tabs.first().press('ArrowRight');
  await reopened.waitForURL((url) => url.hash.endsWith('/trace'));
  assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
  assert.equal(await tabs.nth(1).evaluate((element) => document.activeElement === element), true);
  await tabs.nth(1).press('Home');
  await reopened.waitForURL((url) => url.hash === chatHash);
  assert.equal(await reopened.locator('#prompt-input').inputValue(), 'Preserve this draft.');

  const screenshots = process.env.ATELIER_DESIGN_SCREENSHOTS;
  const capture = async (name: string) => {
    if (screenshots) await reopened.screenshot({ path: join(screenshots, `${name}.png`) });
  };
  await capture('conversation-en-1440');
  await setSize(reopened, 1920, 1080);
  await reopened.getByRole('button', { name: 'Workbench settings', exact: true }).click();
  await reopened.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await capture('settings-en-1920');
  await reopened.getByRole('button', { name: 'Extensions', exact: true }).click();
  await reopened.locator('.ext-page').waitFor();
  await capture('extensions-en-1920');
  await reopened.getByRole('button', { name: 'Agents', exact: true }).click();
  await reopened.locator('.agents-page').waitFor();
  await capture('agents-en-1920');

  await reopened.emulateMedia({ reducedMotion: 'reduce' });
  await setSize(reopened, 680, 800);
  const navToggle = reopened.getByRole('button', { name: 'Open navigation', exact: true });
  await navToggle.press('Enter');
  await reopened.getByRole('dialog', { name: 'Workspace navigation' }).waitFor();
  await capture('navigation-en-680');
  await reopened.keyboard.press('Escape');
  assert.equal(await navToggle.evaluate((element) => document.activeElement === element), true);
  assert.equal(
    await navToggle.evaluate((element) => getComputedStyle(element).transitionDuration),
    '0s',
  );
  assert.deepEqual(requests, ['/v1/messages?beta=true']);
  console.log(
    JSON.stringify({
      zh: first.viewport,
      en: second.viewport,
      cacheHitRate: 0.6,
      requests,
      draftPreserved: true,
      persistedAfterRestart: true,
      requestDisclosure: true,
      sessionTitleEllipsis: true,
      browserTabTitleEllipsis: true,
      browserSlotRestored: true,
      browserChromeAndTopbarHeight: 48,
      drawerAndBrowserSettingsHideAndRestoreNativeView: true,
      browserTabSwitchAndClose: true,
      browserCloseFocusRestored: true,
      nativeKeyboardInput: true,
      nativeSplitResize: true,
      tabKeyboardNavigation: true,
      narrowNavigationFocusRestored: true,
      reducedMotion: true,
      wideViewport: [1920, 1080],
      conversationHorizontalOverflow: layout.scrollWidth - layout.width,
    }),
  );
} finally {
  await app?.close().catch(() => undefined);
  gateway.closeAllConnections();
  await new Promise<void>((done) => gateway.close(() => done()));
  await rm(directory, { recursive: true, force: true });
}
