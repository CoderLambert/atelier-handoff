/**
 * @file 定义桌面浏览器共享协议、操作时限和下载预览约束。
 * @implementation 校验桥接消息、工具参数和结果，统一维护分操作时限、IPC 宽限时间、错误码及下载预览格式与字节上限。
 * @updated 2026-11-20T22:16:28+08:00
 */
import { z } from 'zod';

export const desktopBrowserProtocolVersion = 2;
export const desktopBrowserChannels = {
  layout: 'browser:layout',
  command: 'browser:command',
  readDownload: 'browser:read-download',
  state: 'browser:state',
} as const;

export const desktopBrowserProjectIdSchema = z.uuid();
export const desktopBrowserRequestIdSchema = z.uuid();
export const desktopBrowserUrlSchema = z
  .string()
  .max(16_384)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, '请输入 HTTP 或 HTTPS 网页地址。');

export const desktopBrowserBoundsSchema = z.strictObject({
  x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000),
  width: z.number().finite().min(0).max(1_000_000),
  height: z.number().finite().min(0).max(1_000_000),
});

export const desktopBrowserLayoutSchema = z.strictObject({
  projectId: desktopBrowserProjectIdSchema,
  bounds: desktopBrowserBoundsSchema.nullable(),
});

export const desktopBrowserCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    projectId: desktopBrowserProjectIdSchema,
    action: z.literal([
      'state',
      'take',
      'release',
      'reload',
      'back',
      'forward',
      'new-tab',
      'open-download-directory',
    ]),
  }),
  z.strictObject({
    projectId: desktopBrowserProjectIdSchema,
    action: z.literal(['select-tab', 'close-tab']),
    tabId: z.uuid(),
  }),
  z.strictObject({
    projectId: desktopBrowserProjectIdSchema,
    action: z.literal(['cancel-download', 'reveal-download', 'open-download']),
    downloadId: z.uuid(),
  }),
  z.strictObject({
    projectId: desktopBrowserProjectIdSchema,
    action: z.literal(['navigate', 'open-tab', 'open-external']),
    url: desktopBrowserUrlSchema,
  }),
]);

export const desktopBrowserDownloadSchema = z.strictObject({
  id: z.uuid(),
  filename: z.string(),
  path: z.string(),
  receivedBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  status: z.enum(['progressing', 'completed', 'cancelled', 'interrupted']),
  error: z.string().optional(),
});
export type DesktopBrowserDownload = z.infer<typeof desktopBrowserDownloadSchema>;

export const browserDownloadPreviewMaxBytes = 16 * 1024 * 1024;
const browserDownloadPreviewTypes = new Map([
  ['pdf', 'application/pdf'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['txt', 'text/plain'],
  ['log', 'text/plain'],
  ['csv', 'text/csv'],
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['json', 'application/json'],
]);
export function browserDownloadPreviewMime(filename: string): string | undefined {
  const extension = /\.([^.\/\\]+)$/u.exec(filename)?.[1];
  return extension ? browserDownloadPreviewTypes.get(extension.toLowerCase()) : undefined;
}

export const desktopBrowserReadDownloadSchema = z.strictObject({
  projectId: desktopBrowserProjectIdSchema,
  downloadId: z.uuid(),
});
export const desktopBrowserDownloadPreviewSchema = z.strictObject({
  name: z.string(),
  mimeType: z.string(),
  bytes: z
    .instanceof(ArrayBuffer)
    .refine((value) => value.byteLength <= browserDownloadPreviewMaxBytes),
});
export type DesktopBrowserDownloadPreview = z.infer<typeof desktopBrowserDownloadPreviewSchema>;

export const desktopBrowserStateSchema = z.strictObject({
  projectId: desktopBrowserProjectIdSchema,
  tabs: z.array(z.strictObject({ id: z.uuid(), title: z.string(), url: z.string() })),
  activeTabId: z.uuid().nullable(),
  agentTabId: z.uuid().nullable(),
  transferring: z.boolean(),
  url: z.union([z.literal(''), desktopBrowserUrlSchema]),
  title: z.string(),
  control: z.boolean(),
  busy: z.boolean(),
  downloads: z.array(desktopBrowserDownloadSchema).optional(),
  downloadDirectory: z.string().optional(),
});

export const desktopBrowserAccessUpdateSchema = z.strictObject({
  enabled: z.boolean(),
  revision: z.uuid().nullable(),
});
export const desktopBrowserAccessStateSchema = desktopBrowserAccessUpdateSchema.extend({
  available: z.boolean(),
});
export type DesktopBrowserAccessUpdate = z.infer<typeof desktopBrowserAccessUpdateSchema>;
export type DesktopBrowserAccessState = z.infer<typeof desktopBrowserAccessStateSchema>;

const callHeader = {
  type: z.literal('desktop-browser-call'),
  protocolVersion: z.literal(desktopBrowserProtocolVersion),
  id: desktopBrowserRequestIdSchema,
  projectId: desktopBrowserProjectIdSchema,
  runId: z.uuid(),
  allowedOrigins: z
    .array(
      desktopBrowserUrlSchema.refine(
        (value) => URL.canParse(value) && new URL(value).origin === value,
      ),
    )
    .max(256)
    .optional(),
};
const reference = z
  .string()
  .regex(/^r[1-9]\d*-[1-9]\d*$/)
  .max(64);
const targetSchema = z.strictObject({
  target: reference.optional(),
  ref: reference.optional(),
  element: z.string().max(4_000).optional(),
});
const hasTarget = (value: z.infer<typeof targetSchema>) =>
  Boolean(value.target || value.ref) && (!value.target || !value.ref || value.target === value.ref);

export const desktopBrowserArgs = {
  browser_navigate: z.strictObject({
    url: desktopBrowserUrlSchema,
    waitUntil: z.enum(['domcontentloaded', 'load']).optional(),
    includeSnapshot: z.boolean().optional(),
  }),
  browser_navigate_history: z.strictObject({
    action: z.enum(['back', 'forward', 'reload']),
    includeSnapshot: z.boolean().optional(),
  }),
  browser_snapshot: z.strictObject({
    rootRef: reference.optional(),
    maxNodes: z.int().min(10).max(600).optional(),
  }),
  browser_take_screenshot: z.strictObject({
    type: z.literal('png').optional(),
    filename: z.string().max(512).optional(),
    fullPage: z.boolean().optional(),
  }),
  browser_click: z
    .strictObject({
      ...targetSchema.shape,
      doubleClick: z.boolean().optional(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      includeSnapshot: z.boolean().optional(),
    })
    .refine(hasTarget, '请提供当前页面的有效引用。'),
  browser_type: z
    .strictObject({
      ...targetSchema.shape,
      text: z.string().max(4_000),
      clear: z.boolean().optional(),
      submit: z.boolean().optional(),
      slowly: z.literal(false).optional(),
      includeSnapshot: z.boolean().optional(),
    })
    .refine(hasTarget, '请提供当前页面的有效引用。'),
  browser_fill_form: z.strictObject({
    fields: z
      .array(
        z
          .strictObject({
            target: reference.optional(),
            ref: reference.optional(),
            value: z.string().max(4_000),
            clear: z.boolean().optional(),
          })
          .refine(hasTarget, '请提供当前页面的有效引用。'),
      )
      .min(1)
      .max(30),
    includeSnapshot: z.boolean().optional(),
  }),
  browser_hover: z
    .strictObject({
      ...targetSchema.shape,
      includeSnapshot: z.boolean().optional(),
    })
    .refine(hasTarget, '请提供当前页面的有效引用。'),
  browser_scroll: z.strictObject({
    direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    amount: z.number().finite().min(1).max(10_000).optional(),
    target: reference.optional(),
    ref: reference.optional(),
    includeSnapshot: z.boolean().optional(),
  }),
  browser_press_key: z.strictObject({
    key: z.string().min(1).max(64),
    modifiers: z.array(z.enum(['Control', 'Shift', 'Alt', 'Meta'])).max(4).optional(),
    includeSnapshot: z.boolean().optional(),
  }),
  browser_select_option: z
    .strictObject({
      ...targetSchema.shape,
      value: z.string().max(1_000).optional(),
      label: z.string().max(1_000).optional(),
      includeSnapshot: z.boolean().optional(),
    })
    .refine(hasTarget, '请提供当前页面的有效引用。')
    .refine(
      (value) => value.value !== undefined || value.label !== undefined,
      '请提供要选中的选项值或文本。',
    ),
  browser_wait_for: z
    .strictObject({
      text: z.string().min(1).max(500).optional(),
      textGone: z.string().min(1).max(500).optional(),
      timeoutMs: z.int().min(100).max(25_000).optional(),
      includeSnapshot: z.boolean().optional(),
    })
    .refine(
      (value) =>
        value.text !== undefined || value.textGone !== undefined || value.timeoutMs !== undefined,
      '请提供等待的文本条件或等待时长。',
    ),
  browser_handle_dialog: z.strictObject({
    accept: z.boolean(),
    promptText: z.string().max(4_000).optional(),
    includeSnapshot: z.boolean().optional(),
  }),
};
export type DesktopBrowserToolName = keyof typeof desktopBrowserArgs;

const desktopBrowserReadOnlyTools = new Set<DesktopBrowserToolName>([
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_scroll',
  'browser_hover',
  'browser_wait_for',
]);

const desktopBrowserInputTools = new Set<DesktopBrowserToolName>([
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
  'browser_select_option',
  'browser_handle_dialog',
]);

export const isDesktopBrowserReadOnlyTool = (name: DesktopBrowserToolName): boolean =>
  desktopBrowserReadOnlyTools.has(name);

export const isDesktopBrowserInputTool = (name: DesktopBrowserToolName): boolean =>
  desktopBrowserInputTools.has(name);

export const desktopBrowserTimeoutMs = (name: DesktopBrowserToolName) =>
  name === 'browser_navigate' || name === 'browser_navigate_history' ? 60_000 : 30_000;
export const desktopBrowserIpcGraceMs = 5_000;
export const desktopBrowserErrorCodeSchema = z.enum([
  'DESKTOP_BROWSER_TIMEOUT',
  'DESKTOP_BROWSER_RENDERER_GONE',
]);

export const desktopBrowserCallSchema = z.discriminatedUnion('name', [
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_navigate'),
    args: desktopBrowserArgs.browser_navigate,
  }),
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_navigate_history'),
    args: desktopBrowserArgs.browser_navigate_history,
  }),
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_snapshot'),
    args: desktopBrowserArgs.browser_snapshot,
  }),
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_take_screenshot'),
    args: desktopBrowserArgs.browser_take_screenshot,
  }),
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_click'),
    args: desktopBrowserArgs.browser_click,
  }),
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_type'),
    args: desktopBrowserArgs.browser_type,
  }),
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_fill_form'),
    args: desktopBrowserArgs.browser_fill_form,
  }),
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_hover'),
    args: desktopBrowserArgs.browser_hover,
  }),
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_scroll'),
    args: desktopBrowserArgs.browser_scroll,
  }),
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_press_key'),
    args: desktopBrowserArgs.browser_press_key,
  }),
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_select_option'),
    args: desktopBrowserArgs.browser_select_option,
  }),
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_wait_for'),
    args: desktopBrowserArgs.browser_wait_for,
  }),
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_handle_dialog'),
    args: desktopBrowserArgs.browser_handle_dialog,
  }),
]);

export const desktopBrowserCancelSchema = z.strictObject({
  type: z.literal('desktop-browser-cancel'),
  protocolVersion: z.literal(desktopBrowserProtocolVersion),
  id: desktopBrowserRequestIdSchema,
});

const resultHeader = {
  type: z.literal('desktop-browser-result'),
  protocolVersion: z.literal(desktopBrowserProtocolVersion),
  id: desktopBrowserRequestIdSchema,
};
// Only identifies a pending call when the rest of its response is malformed.
export const desktopBrowserResultIdentitySchema = z.object(resultHeader);
export const desktopBrowserResultSchema = z.union([
  z.strictObject({
    ...resultHeader,
    text: z.string(),
    png: z.never().optional(),
    error: z.never().optional(),
  }),
  z.strictObject({
    ...resultHeader,
    png: z
      .base64()
      .min(1)
      .max(32 * 1024 * 1024),
    text: z.never().optional(),
    error: z.never().optional(),
  }),
  z.strictObject({
    ...resultHeader,
    error: z.string().min(1),
    errorCode: desktopBrowserErrorCodeSchema.optional(),
    text: z.never().optional(),
    png: z.never().optional(),
  }),
]);

export type DesktopBrowserLayout = z.infer<typeof desktopBrowserLayoutSchema>;
export type DesktopBrowserCommand = z.infer<typeof desktopBrowserCommandSchema>;
export type DesktopBrowserAction = DesktopBrowserCommand['action'];
export type DesktopBrowserState = z.infer<typeof desktopBrowserStateSchema>;
export type DesktopBrowserCall = z.infer<typeof desktopBrowserCallSchema>;
export type DesktopBrowserResult = z.infer<typeof desktopBrowserResultSchema>;

export interface DesktopBrowserBridge {
  layout(
    projectId: DesktopBrowserLayout['projectId'],
    bounds: DesktopBrowserLayout['bounds'],
  ): void;
  command(
    projectId: DesktopBrowserCommand['projectId'],
    action: DesktopBrowserAction,
    value?: string,
  ): Promise<void>;
  readDownload(projectId: string, downloadId: string): Promise<DesktopBrowserDownloadPreview>;
  subscribe(callback: (state: DesktopBrowserState) => void): () => void;
}
