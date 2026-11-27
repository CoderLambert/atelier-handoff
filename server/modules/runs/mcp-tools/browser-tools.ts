/**
 * @file 注册桌面原生浏览器的运行工具。
 * @implementation 以固定浏览器修订和取消信号复核控制权，按运行模式审批交互，通过宿主能力保存 PNG 截图。
 * @updated 2026-11-27T22:35:00+08:00
 */
import type { z } from 'zod';
import {
  desktopBrowserArgs,
  type DesktopBrowserToolName,
} from '../../../../shared/desktop-browser.js';
import { callDesktopBrowser } from '../../../desktop-browser.js';
import type { RunMcpToolHost, ToolRegistration } from './types.js';

export function registerBrowserTools(
  host: RunMcpToolHost,
  { custom, mcpTools }: ToolRegistration,
  publishScreenshot?: (data: string) => Promise<string>,
) {
  const { browserAccess, run, allowed, toolSignal, projectId, verifyCurrent, approve } = host;
  const browserRevision = run.browserRevision;
  if (browserAccess && browserRevision && allowed('browser') && !run.retryOf) {
    const registerBrowser = <S extends z.ZodRawShape>(
      name: DesktopBrowserToolName,
      description: string,
      shape: S,
      approval = false,
    ) => {
      mcpTools.push(
        custom(name, description, shape, async (args, toolCallId) => {
          const input = desktopBrowserArgs[name].parse(args);
          const operationSignal = AbortSignal.any([
            toolSignal(),
            browserAccess.signal(projectId, browserRevision),
          ]);
          const recheck = () => {
            verifyCurrent();
            operationSignal.throwIfAborted();
            browserAccess.verify(projectId, browserRevision);
          };
          recheck();
          if (approval) {
            await approve(
              {
                toolCallId,
                kind: 'browser',
                command: `${name}\n${JSON.stringify(input, null, 2)}`,
                reason: '在项目当前的 Agent 浏览器标签页执行此操作。',
              },
              operationSignal,
            );
          }
          recheck();
          const result = await callDesktopBrowser(projectId, run.id, name, input, operationSignal);
          recheck();
          if (result.png && publishScreenshot) {
            const artifactId = await publishScreenshot(result.png);
            return `已保存当前网页截图到交付物（ID ${artifactId}）。`;
          }
          return result.text ?? '浏览器操作已完成。';
        }),
      );
    };
    registerBrowser(
      'browser_navigate',
      'Open an HTTP or HTTPS URL in the native desktop browser tab. Defaults to waitUntil="domcontentloaded" for fast loading on heavy sites; pass includeSnapshot=true to receive the updated accessibility tree immediately.',
      desktopBrowserArgs.browser_navigate.shape,
    );
    registerBrowser(
      'browser_navigate_history',
      'Navigate back, forward, or reload the native desktop browser tab.',
      desktopBrowserArgs.browser_navigate_history.shape,
    );
    registerBrowser(
      'browser_snapshot',
      'Read the native browser page title, URL, and hierarchical accessibility tree with element states. Use the returned refs in subsequent actions.',
      desktopBrowserArgs.browser_snapshot.shape,
    );
    registerBrowser(
      'browser_scroll',
      'Scroll the native browser viewport or a specific scrollable container ref.',
      desktopBrowserArgs.browser_scroll.shape,
    );
    registerBrowser(
      'browser_hover',
      'Move the pointer over a ref from the native browser snapshot to reveal hover menus or tooltips.',
      desktopBrowserArgs.browser_hover.shape,
    );
    registerBrowser(
      'browser_wait_for',
      'Wait until specified text appears or disappears on the native browser page, or wait for a short duration.',
      desktopBrowserArgs.browser_wait_for.shape,
    );
    if (publishScreenshot)
      registerBrowser(
        'browser_take_screenshot',
        'Save a PNG screenshot (viewport or fullPage) of the native browser page to the current session artifacts.',
        desktopBrowserArgs.browser_take_screenshot.shape,
      );
    if (run.mode === 'edit') {
      registerBrowser(
        'browser_click',
        'Click a ref from the native browser snapshot. Supports left/right/middle click and double click. The run approval policy applies.',
        desktopBrowserArgs.browser_click.shape,
        true,
      );
      registerBrowser(
        'browser_type',
        'Enter text in an editable ref from the native browser snapshot. Set clear=false to append without clearing. Ask the user to enter credentials manually. The run approval policy applies.',
        desktopBrowserArgs.browser_type.shape,
        true,
      );
      registerBrowser(
        'browser_fill_form',
        'Fill multiple form fields (inputs or native <select> elements) in a single approved call using refs from the latest snapshot. Ask the user to enter credentials manually. The run approval policy applies.',
        desktopBrowserArgs.browser_fill_form.shape,
        true,
      );
      registerBrowser(
        'browser_press_key',
        'Press a keyboard key or shortcut (e.g. Escape, Tab, Enter, ArrowDown, Backspace) in the native browser tab. The run approval policy applies.',
        desktopBrowserArgs.browser_press_key.shape,
        true,
      );
      registerBrowser(
        'browser_select_option',
        'Select an option by value or visible label in a native <select> element ref. The run approval policy applies.',
        desktopBrowserArgs.browser_select_option.shape,
        true,
      );
      registerBrowser(
        'browser_handle_dialog',
        'Accept or dismiss an open JavaScript alert, confirm, prompt, or beforeunload dialog on the native browser page. The run approval policy applies.',
        desktopBrowserArgs.browser_handle_dialog.shape,
        true,
      );
    }
  }
}
