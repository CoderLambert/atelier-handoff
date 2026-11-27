/**
 * @file 注册桌面原生浏览器的运行工具。
 * @implementation 以固定浏览器修订和取消信号复核控制权，按运行模式审批交互，通过宿主能力保存 PNG 截图。
 * @updated 2026-11-27T17:26:33+08:00
 */
import type { z } from 'zod';
import {
  desktopBrowserArgs,
  type DesktopBrowserToolName,
} from '../../../../shared/desktop-browser.js';
import { callDesktopBrowser } from '../../../desktop-browser.js';
import type { RunMcpToolHost, ToolRegistration } from './index.js';

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
      'Open an HTTP or HTTPS URL in the native desktop browser tab.',
      desktopBrowserArgs.browser_navigate.shape,
    );
    registerBrowser(
      'browser_snapshot',
      'Read the native browser page title, URL and visible accessibility elements. Use the returned refs in click or type calls.',
      desktopBrowserArgs.browser_snapshot.shape,
    );
    if (publishScreenshot)
      registerBrowser(
        'browser_take_screenshot',
        'Save a PNG screenshot of the native browser page to the current session artifacts.',
        desktopBrowserArgs.browser_take_screenshot.shape,
      );
    if (run.mode === 'edit') {
      registerBrowser(
        'browser_click',
        'Click a ref from the latest native browser snapshot. The run approval policy applies.',
        desktopBrowserArgs.browser_click.shape,
        true,
      );
      registerBrowser(
        'browser_type',
        'Enter text in a ref from the latest native browser snapshot. The run approval policy applies. Ask the user to enter credentials manually.',
        desktopBrowserArgs.browser_type.shape,
        true,
      );
    }
  }
}
