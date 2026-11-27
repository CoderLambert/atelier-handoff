/**
 * @file 执行桌面原生浏览器的各类工具调用、CDP 挂载、弹窗竞态与导航稳定等待。
 * @implementation 按工具类型分派导航、历史、弹窗决策、快照、截图及键鼠交互，并在操作触发 JS 弹窗时非阻塞回报给 Agent 决策。
 * @updated 2026-11-27T23:40:00+08:00
 */
import type { BrowserWindow, WebContents, WebContentsView } from 'electron';
import {
  isDesktopBrowserReadOnlyTool,
  type DesktopBrowserCall,
} from '../../shared/desktop-browser.js';
import {
  executeCdpClick,
  executeCdpFillForm,
  executeCdpHover,
  executeCdpPressKey,
  executeCdpScreenshot,
  executeCdpScroll,
  executeCdpSelectOption,
  executeCdpType,
  executeCdpWaitFor,
  formatPendingDialogNotice,
  parseJavascriptDialogOpening,
  snapshotAccessibilityTree,
  type BrowserRefTarget,
  type CdpExpectedInputHooks,
  type PendingBrowserDialog,
} from './cdp-driver.mjs';
import type { BrowserOperationContext } from './operation-lifecycle.mjs';

export interface ExecutableBrowserTab extends CdpExpectedInputHooks {
  readonly id: string;
  readonly owner: BrowserWindow;
  readonly view: WebContentsView;
  readonly refs: Map<string, BrowserRefTarget>;
  cdpBound?: boolean;
  pageEnabled?: boolean;
  pendingDialog?: PendingBrowserDialog;
  onDialogOpened?: (dialog: PendingBrowserDialog) => void;
}

export interface BrowserToolExecutorDeps {
  readonly tab: ExecutableBrowserTab;
  readonly wc: WebContents;
  readonly request: DesktopBrowserCall;
  readonly context: BrowserOperationContext;
  readonly siteUrl: (value: string) => string;
  readonly isVisible: () => boolean;
  readonly assertOwned: () => void;
  readonly nextRevision: () => number;
}

export type BrowserToolResult =
  { text: string; png?: undefined } | { png: string; text?: undefined };

async function ensureCdp(
  tab: ExecutableBrowserTab,
  wc: WebContents,
  send: (name: string, params?: object) => Promise<unknown>,
): Promise<void> {
  const cdp = wc.debugger;
  if (!cdp.isAttached()) {
    cdp.attach('1.3');
    tab.pageEnabled = false;
  }
  if (!tab.cdpBound) {
    tab.cdpBound = true;
    cdp.on('detach', () => {
      tab.pageEnabled = false;
      tab.pendingDialog = undefined;
    });
    cdp.on('message', (_event, method, params: unknown) => {
      if (method === 'Page.javascriptDialogOpening') {
        const dialog = parseJavascriptDialogOpening(params);
        if (dialog) {
          tab.pendingDialog = dialog;
          tab.onDialogOpened?.(dialog);
        }
      } else if (method === 'Page.javascriptDialogClosed') {
        tab.pendingDialog = undefined;
      }
    });
  }
  if (!tab.pageEnabled) {
    await send('Page.enable');
    tab.pageEnabled = true;
  }
}

async function settleAfterAction(
  wc: WebContents,
  signal: AbortSignal,
  waitForNative: <V>(pending: Promise<V>) => Promise<V>,
  dialogOpened: Promise<PendingBrowserDialog>,
): Promise<PendingBrowserDialog | undefined> {
  let navStarted = false;
  const onNav = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame && !isInPlace) navStarted = true;
  };
  wc.on('did-start-navigation', onNav);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const shortWait = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), 150);
    onAbort = () => {
      if (timer) clearTimeout(timer);
      resolve(undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  let maybeDialog: PendingBrowserDialog | undefined;
  try {
    maybeDialog = await Promise.race([shortWait, dialogOpened]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    wc.removeListener('did-start-navigation', onNav);
  }
  if (maybeDialog) return maybeDialog;
  if (!navStarted || signal.aborted || !wc.isLoadingMainFrame()) return undefined;

  let done = () => {};
  const settled = new Promise<undefined>((resolve) => {
    done = () => resolve(undefined);
    wc.once('did-finish-load', done);
    wc.once('did-fail-load', done);
    wc.once('did-stop-loading', done);
  });
  try {
    return await Promise.race([waitForNative(settled), dialogOpened]);
  } finally {
    wc.removeListener('did-finish-load', done);
    wc.removeListener('did-fail-load', done);
    wc.removeListener('did-stop-loading', done);
  }
}

async function navigateWithWaitUntil(
  wc: WebContents,
  destination: string,
  waitUntil: 'domcontentloaded' | 'load',
  signal: AbortSignal,
  waitForNative: <V>(pending: Promise<V>) => Promise<V>,
  dialogOpened: Promise<PendingBrowserDialog>,
): Promise<PendingBrowserDialog | undefined> {
  if (waitUntil === 'load') {
    let dialogWon = false;
    const loadWork = waitForNative(wc.loadURL(destination)).then(
      () => undefined,
      (error: unknown) => {
        if (dialogWon) return new Promise<never>(() => {});
        throw error;
      },
    );
    const dialogWork = dialogOpened.then((dialog) => {
      dialogWon = true;
      return dialog;
    });
    return Promise.race([loadWork, dialogWork]);
  }

  let resolvedEarly = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let onDomReady: (() => void) | undefined;
  let onFinishLoad: (() => void) | undefined;

  const loadPromise = wc.loadURL(destination);
  const guardedLoad = loadPromise.then(
    () => undefined,
    (error: unknown) => {
      if (resolvedEarly) return new Promise<never>(() => {});
      throw error;
    },
  );

  const domReadyPromise = new Promise<undefined>((resolve) => {
    const complete = () => {
      resolvedEarly = true;
      if (settleTimer) clearTimeout(settleTimer);
      resolve(undefined);
    };
    onFinishLoad = complete;
    onDomReady = () => {
      if (settleTimer) return;
      settleTimer = setTimeout(complete, 400);
    };
    onAbort = () => {
      if (settleTimer) clearTimeout(settleTimer);
    };
    wc.once('dom-ready', onDomReady);
    wc.once('did-finish-load', onFinishLoad);
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([
      waitForNative(Promise.race([guardedLoad, domReadyPromise])),
      dialogOpened.then((dialog) => {
        resolvedEarly = true;
        return dialog;
      }),
    ]);
  } finally {
    if (settleTimer) clearTimeout(settleTimer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (onDomReady) wc.removeListener('dom-ready', onDomReady);
    if (onFinishLoad) wc.removeListener('did-finish-load', onFinishLoad);
  }
}

export async function executeBrowserTool(
  deps: BrowserToolExecutorDeps,
): Promise<BrowserToolResult> {
  const { tab, wc, request, context, siteUrl, isVisible, assertOwned, nextRevision } = deps;
  const { signal, waitForNative, markInputDispatched } = context;
  const { allowedOrigins } = request;
  const cdp = wc.debugger;

  if (tab.pendingDialog && request.name !== 'browser_handle_dialog') {
    return { text: formatPendingDialogNotice(tab.pendingDialog, false) };
  }

  let resolveDialog: ((dialog: PendingBrowserDialog) => void) | undefined;
  const dialogOpened = new Promise<PendingBrowserDialog>((resolve) => {
    resolveDialog = resolve;
  });
  tab.onDialogOpened = (dialog) => {
    resolveDialog?.(dialog);
  };

  const readOnly = isDesktopBrowserReadOnlyTool(request.name);

  const send = async (name: string, params?: object): Promise<unknown> => {
    signal.throwIfAborted();
    if (!readOnly && (name.startsWith('Input.') || name === 'Page.handleJavaScriptDialog'))
      markInputDispatched();
    const result: unknown = await waitForNative(cdp.sendCommand(name, params));
    signal.throwIfAborted();
    return result;
  };

  const raceDialog = async <V,>(
    work: Promise<V>,
  ): Promise<{ dialog: PendingBrowserDialog } | { value: V }> => {
    let dialogWon = false;
    const guardedWork = work.then(
      (value) => ({ value }),
      (error: unknown) => {
        if (dialogWon) return new Promise<never>(() => {});
        throw error;
      },
    );
    const guardedDialog = dialogOpened.then((dialog) => {
      dialogWon = true;
      return { dialog };
    });
    return Promise.race([guardedWork, guardedDialog]);
  };

  const withOptionalSnapshot = async (
    text: string,
    includeSnapshot?: boolean,
  ): Promise<{ text: string }> => {
    if (!includeSnapshot || signal.aborted) return { text };
    const currentUrl = wc.getURL();
    if (!currentUrl || currentUrl === 'about:blank') return { text };
    await ensureCdp(tab, wc, send);
    const snap = await snapshotAccessibilityTree({
      send,
      refs: tab.refs,
      revision: nextRevision(),
      url: currentUrl,
      title: wc.getTitle(),
      assertTabOwned: assertOwned,
    });
    return { text: `${text}\n\n${snap.text}` };
  };

  if (request.name === 'browser_navigate') {
    const destination = siteUrl(request.args.url);
    if (allowedOrigins && !allowedOrigins.includes(new URL(destination).origin))
      throw new Error('站点未在项目的浏览器授权范围内。');
    // Only attach CDP before loadURL if a page is already loaded (e.g. to catch beforeunload).
    // A brand-new WebContentsView has no renderer yet, so Page.enable before the first loadURL hangs.
    const existingUrl = wc.getURL();
    if (existingUrl && existingUrl !== 'about:blank' && cdp.isAttached()) {
      await ensureCdp(tab, wc, send);
    }
    const dialog = await navigateWithWaitUntil(
      wc,
      destination,
      request.args.waitUntil ?? 'domcontentloaded',
      signal,
      waitForNative,
      dialogOpened,
    );
    if (dialog) return { text: formatPendingDialogNotice(dialog, true) };
    signal.throwIfAborted();
    assertOwned();
    return withOptionalSnapshot(
      `已打开 ${wc.getURL()}\n页面标题：${wc.getTitle()}`,
      request.args.includeSnapshot,
    );
  }

  if (request.name === 'browser_handle_dialog') {
    if (!tab.pendingDialog) return { text: '当前没有打开的浏览器弹窗。' };
    await ensureCdp(tab, wc, send);
    await send('Page.handleJavaScriptDialog', {
      accept: request.args.accept,
      promptText: request.args.promptText,
    });
    tab.pendingDialog = undefined;
    const nextDialog = await settleAfterAction(wc, signal, waitForNative, dialogOpened);
    if (nextDialog) return { text: formatPendingDialogNotice(nextDialog, true) };
    assertOwned();
    return withOptionalSnapshot(
      `已${request.args.accept ? '确认' : '取消'}浏览器弹窗。\n当前地址：${wc.getURL()}\n页面标题：${wc.getTitle()}`,
      request.args.includeSnapshot,
    );
  }

  const url = wc.getURL();
  if (!url || url === 'about:blank') throw new Error('当前标签尚未打开网页，请先打开网址。');
  if (allowedOrigins && !allowedOrigins.includes(new URL(url).origin))
    throw new Error('当前页面未在项目的浏览器授权范围内。');

  if (request.name === 'browser_navigate_history') {
    await ensureCdp(tab, wc, send);
    const { action } = request.args;
    if (action === 'back' && !wc.navigationHistory.canGoBack())
      return { text: '当前标签没有可后退的历史页面。' };
    if (action === 'forward' && !wc.navigationHistory.canGoForward())
      return { text: '当前标签没有可前进的历史页面。' };
    let finish = () => {};
    const loaded = new Promise<void>((resolve) => {
      finish = () => resolve();
      wc.once('did-finish-load', finish);
      wc.once('did-fail-load', finish);
      wc.once('did-stop-loading', finish);
      wc.once('did-navigate-in-page', finish);
    });
    try {
      if (action === 'back') wc.navigationHistory.goBack();
      else if (action === 'forward') wc.navigationHistory.goForward();
      else wc.reload();
      const outcome = await raceDialog(waitForNative(loaded));
      if ('dialog' in outcome) return { text: formatPendingDialogNotice(outcome.dialog, true) };
    } finally {
      wc.removeListener('did-finish-load', finish);
      wc.removeListener('did-fail-load', finish);
      wc.removeListener('did-stop-loading', finish);
      wc.removeListener('did-navigate-in-page', finish);
    }
    signal.throwIfAborted();
    assertOwned();
    return withOptionalSnapshot(
      `当前地址：${wc.getURL()}\n页面标题：${wc.getTitle()}`,
      request.args.includeSnapshot,
    );
  }

  await ensureCdp(tab, wc, send);

  if (request.name === 'browser_take_screenshot') {
    const detached = !tab.owner.contentView.children.includes(tab.view);
    if (detached) {
      const bounds = tab.view.getBounds();
      if (bounds.width < 1 || bounds.height < 1) {
        tab.view.setBounds({ x: 0, y: 0, width: 960, height: 640 });
      }
      tab.owner.contentView.addChildView(tab.view, 0);
    }
    try {
      try {
        const shot = await executeCdpScreenshot({ send }, { fullPage: request.args.fullPage });
        signal.throwIfAborted();
        assertOwned();
        return shot;
      } catch (error) {
        if (request.args.fullPage || signal.aborted) throw error;
        const capture = await waitForNative(wc.capturePage(undefined, { stayHidden: false }));
        signal.throwIfAborted();
        assertOwned();
        return { png: capture.toPNG().toString('base64') };
      }
    } finally {
      if (
        detached &&
        !isVisible() &&
        !tab.owner.isDestroyed() &&
        tab.owner.contentView.children.includes(tab.view)
      )
        tab.owner.contentView.removeChildView(tab.view);
    }
  }

  if (request.name === 'browser_snapshot') {
    return snapshotAccessibilityTree({
      send,
      refs: tab.refs,
      revision: nextRevision(),
      url: wc.getURL(),
      title: wc.getTitle(),
      rootRef: request.args.rootRef,
      maxNodes: request.args.maxNodes,
      assertTabOwned: assertOwned,
    });
  }

  const cdpSession = {
    refs: tab.refs,
    hooks: tab,
    send,
    zoomFactor: () => wc.getZoomFactor(),
  };

  if (request.name === 'browser_scroll') {
    await executeCdpScroll(cdpSession, {
      direction: request.args.direction,
      amount: request.args.amount,
      targetRef: request.args.target ?? request.args.ref,
    });
    assertOwned();
    return withOptionalSnapshot('已滚动页面。', request.args.includeSnapshot);
  }
  if (request.name === 'browser_hover') {
    await executeCdpHover(cdpSession, request.args.target ?? request.args.ref);
    assertOwned();
    return withOptionalSnapshot('已将指针悬停到目标元素。', request.args.includeSnapshot);
  }
  if (request.name === 'browser_wait_for') {
    const waited = await executeCdpWaitFor(cdpSession, {
      text: request.args.text,
      textGone: request.args.textGone,
      timeoutMs: request.args.timeoutMs,
      signal,
    });
    assertOwned();
    return withOptionalSnapshot(waited.text, request.args.includeSnapshot);
  }

  const actionWork = (async (): Promise<string> => {
    if (request.name === 'browser_type') {
      await executeCdpType(cdpSession, request.args.target ?? request.args.ref, request.args.text, {
        clear: request.args.clear,
        submit: request.args.submit,
      });
      return '已输入文本。';
    }
    if (request.name === 'browser_fill_form') {
      const { filledCount } = await executeCdpFillForm(cdpSession, request.args.fields);
      return `已批量填写 ${filledCount} 项表单字段。`;
    }
    if (request.name === 'browser_press_key') {
      await executeCdpPressKey(cdpSession, request.args.key, request.args.modifiers);
      return `已按下按键 ${request.args.key}。`;
    }
    if (request.name === 'browser_select_option') {
      const selected = await executeCdpSelectOption(
        cdpSession,
        request.args.target ?? request.args.ref,
        { value: request.args.value, label: request.args.label },
      );
      return `已选中选项：${selected.selectedLabel}（${selected.selectedValue}）。`;
    }
    await executeCdpClick(cdpSession, request.args.target ?? request.args.ref, {
      doubleClick: request.args.doubleClick,
      button: request.args.button,
    });
    return '已点击目标元素。';
  })();

  const outcome = await raceDialog(actionWork);
  if ('dialog' in outcome) return { text: formatPendingDialogNotice(outcome.dialog, true) };
  const postDialog = await settleAfterAction(wc, signal, waitForNative, dialogOpened);
  if (postDialog) return { text: formatPendingDialogNotice(postDialog, true) };
  assertOwned();
  return withOptionalSnapshot(
    `${outcome.value}\n当前地址：${wc.getURL()}\n页面标题：${wc.getTitle()}`,
    request.args.includeSnapshot,
  );
}
