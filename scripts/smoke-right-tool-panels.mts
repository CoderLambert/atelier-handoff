/**
 * @file 验收真实 Electron 工作区的右侧工具布局。
 * @implementation 隔离项目、数据和 profile，使用真实 Git、PTY 与 WebContentsView 验证拖拽、全屏、收起和恢复，不调用模型。
 * @updated 2026-11-27T12:00:00+08:00
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication } from 'playwright-core';
import type { DesktopUiLanguageBridge } from '../shared/desktop-ui-language.js';
import { openPersistedSessionFixture } from './p1-smoke/persisted-session.mjs';

const root = await mkdtemp(join(tmpdir(), 'atelier-right-tools-'));
const project = join(root, 'project');
const evidence = resolve(process.env.ATELIER_PANEL_EVIDENCE ?? '.local/right-tool-panels');
let app: ElectronApplication | undefined;
let passed = false;
try {
  await mkdir(project);
  await mkdir(evidence, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', project]);
  await writeFile(join(project, 'README.md'), '# Isolated layout fixture\n');
  execFileSync('git', ['-C', project, 'add', 'README.md']);
  execFileSync('git', [
    '-C',
    project,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Fixture',
  ]);
  await writeFile(join(project, 'README.md'), '# Local change\n');
  const desktop = await _electron.launch({
    executablePath: resolve('node_modules/electron/dist/electron'),
    args: [
      resolve('dist/desktop/main.mjs'),
      `--user-data-dir=${join(root, 'profile')}`,
      '--disable-gpu',
      '--ozone-platform=headless',
      '--ozone-override-screen-size=2400,1000',
    ],
    env: {
      ...process.env,
      ATELIER_DATA_DIR: join(root, 'data'),
      ATELIER_PORT: '0',
      ATELIER_NATIVE_EXECUTION: '1',
      ATELIER_MAGPIE_URL: '',
    },
  });
  app = desktop;
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => console.error(error));
  async function size(width: number) {
    await desktop.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setContentSize(width, 800),
      width,
    );
    await page.waitForFunction((width) => innerWidth === width, width);
  }
  await size(2240);
  const dialog = page.getByRole('dialog', { name: '绑定项目目录' });
  await dialog.getByLabel('本机目录').fill(project);
  await dialog.getByRole('button', { name: '绑定项目', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await openPersistedSessionFixture(page);
  const topbar = page.locator('.topbar');
  const splitter = page.locator('#resize-inspector');
  const tool = page.locator('.workspace-right-tool');
  async function width(expected: number) {
    await page.waitForFunction(
      (width) =>
        Math.abs(
          (document.querySelector('.workspace-right-tool')?.getBoundingClientRect().width ?? 0) -
            width,
        ) < 2,
      expected,
    );
  }
  async function dragTo(target: number) {
    const bounds = await splitter.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 150);
    await page.mouse.down();
    await page.mouse.move(target, bounds.y + 150, { steps: 15 });
    await page.mouse.up();
  }
  async function nativeView() {
    return desktop.evaluate(({ BrowserWindow, WebContentsView }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = window?.contentView.children.find(
        (view) => view instanceof WebContentsView && view.webContents !== window.webContents,
      );
      return view instanceof WebContentsView
        ? { id: view.webContents.id, bounds: view.getBounds() }
        : null;
    });
  }
  async function untilNative(check: (view: Awaited<ReturnType<typeof nativeView>>) => boolean) {
    const deadline = Date.now() + 5000;
    do {
      const view = await nativeView();
      if (check(view)) return view;
      await new Promise((done) => setTimeout(done, 50));
    } while (Date.now() < deadline);
    assert.fail('Native view did not match expected bounds or identity');
  }
  const panels = [
    {
      selector: '.terminal-panel',
      name: ['终端', 'Terminal'],
      collapse: ['收起终端面板', 'Hide terminal panel'],
    },
    { selector: '.git-board', name: ['Git', 'Git'], collapse: ['收起 Git 面板', 'Hide Git panel'] },
    {
      selector: '.workspace-browser-panel',
      name: ['浏览器', 'Browser'],
      collapse: ['收起浏览器面板', 'Hide browser panel'],
    },
  ] as const;
  for (const language of [0, 1] as const) {
    for (const definition of panels) {
      const trigger = topbar.getByRole('button', { name: definition.name[language], exact: true });
      const panel = page.locator(definition.selector);
      await trigger.click();
      await panel.waitFor();
      await splitter.waitFor();
      const terminalInput = panel.locator('.xterm-helper-textarea');
      if (definition.selector === '.terminal-panel') {
        await terminalInput.waitFor();
        await terminalInput.focus();
        await page.keyboard.type('export ATELIER_LAYOUT_TEST=PanelFixtureAlive');
        await terminalInput.press('Enter');
      }
      const commit = panel.locator('textarea').first();
      if (definition.selector === '.git-board') await commit.fill('Retained Git draft');
      const native =
        definition.selector === '.workspace-browser-panel'
          ? await untilNative((view) => Boolean(view?.bounds.width))
          : null;
      await dragTo(2238);
      await width(450);
      await dragTo(0);
      await width(1440);
      const expand = panel.getByRole('button', {
        name: language ? /^Expand .* to full window$/u : /^全屏/u,
      });
      const dock = panel.getByRole('button', {
        name: language ? /^Dock /u : /^(?:恢复|收回).*侧栏$/u,
      });
      await expand.click();
      await width(2240);
      assert.equal(await splitter.count(), 0);
      if (native)
        await untilNative(
          (view) => view?.id === native.id && view.bounds.x === 0 && view.bounds.width === 2240,
        );
      const collapse = panel.getByRole('button', {
        name: definition.collapse[language],
        exact: true,
      });
      const route = new URL(page.url()).hash;
      await collapse.click();
      await tool.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.closest('.topbar'));
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
      assert.equal(new URL(page.url()).hash, route);
      if (native) await untilNative((view) => view === null);
      await trigger.press('Enter');
      await width(2240);
      if (native) await untilNative((view) => view?.id === native.id && view.bounds.width === 2240);
      await dock.click();
      await width(1440);
      await size(1000);
      await width(1000);
      assert.equal(await splitter.count(), 0);
      await size(2240);
      await width(1440);
      if (definition.selector === '.git-board')
        assert.equal(await commit.inputValue(), 'Retained Git draft');
      if (definition.selector === '.terminal-panel') {
        await terminalInput.focus();
        await page.keyboard.type('printf "%s\\n" "$ATELIER_LAYOUT_TEST"');
        await terminalInput.press('Enter');
        await panel.getByText('PanelFixtureAlive', { exact: true }).waitFor();
      }
      console.log(
        `${definition.name[language]} (${language ? 'en' : 'zh-CN'}): 450–1440 px, narrow window, full window, collapse, restore`,
      );
    }
    if (language === 0) {
      await page.evaluate(async () => {
        const { atelierUiLanguage } = window as Window & {
          atelierUiLanguage?: DesktopUiLanguageBridge;
        };
        if (!atelierUiLanguage) throw new Error('Missing desktop locale bridge');
        await atelierUiLanguage.set('en');
      });
      await tool.getByRole('button', { name: '收起浏览器面板', exact: true }).click();
      await page.getByRole('tab', { name: '会话', exact: true }).click();
      await page.reload();
    }
  }
  passed = true;
} finally {
  if (app) {
    const page = app.windows()[0];
    if (page)
      await page
        .screenshot({ path: join(evidence, passed ? 'electron-last.png' : 'electron-failed.png') })
        .catch(() => {});
    await app.close();
  }
  if (passed) await rm(root, { recursive: true });
  else console.error(`Isolated data retained: ${root}`);
}
