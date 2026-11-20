/**
 * @file 定义桌面浏览器共享协议和类型。
 * @implementation 使用 Zod 描述并校验桥接消息、操作参数与结果。
 * @updated 2026-11-20T02:00+08:00
 */
import { z } from 'zod';

export const desktopBrowserProtocolVersion = 2;
export const desktopBrowserChannels = {
  layout: 'browser:layout',
  command: 'browser:command',
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
    action: z.literal(['cancel-download', 'reveal-download']),
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
  browser_navigate: z.strictObject({ url: desktopBrowserUrlSchema }),
  browser_snapshot: z.strictObject({}),
  browser_take_screenshot: z.strictObject({
    type: z.literal('png').optional(),
    filename: z.string().max(512).optional(),
    fullPage: z.literal(false).optional(),
  }),
  browser_click: z
    .strictObject({
      ...targetSchema.shape,
      doubleClick: z.boolean().optional(),
      button: z.literal('left').optional(),
    })
    .refine(hasTarget, '请提供当前页面的有效引用。'),
  browser_type: z
    .strictObject({
      ...targetSchema.shape,
      text: z.string().max(4_000),
      submit: z.boolean().optional(),
      slowly: z.literal(false).optional(),
    })
    .refine(hasTarget, '请提供当前页面的有效引用。'),
};
export type DesktopBrowserToolName = keyof typeof desktopBrowserArgs;

export const desktopBrowserCallSchema = z.discriminatedUnion('name', [
  z.strictObject({
    ...callHeader,
    name: z.literal('browser_navigate'),
    args: desktopBrowserArgs.browser_navigate,
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
  subscribe(callback: (state: DesktopBrowserState) => void): () => void;
}
