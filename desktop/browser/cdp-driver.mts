/**
 * @file 封装原生浏览器 CDP 键鼠交互、滚动、悬停、下拉选择、等待与截图驱动。
 * @implementation 通过 withExpectedKey/withExpectedMouse 守卫放行受控输入，优先采用 getContentQuads 定位与跨平台键码映射，并将失效节点错误转为可读提示。
 * @updated 2026-11-27T23:35:00+08:00
 */
import type { Input, MouseInputEvent } from 'electron';
import { z } from 'zod';
import {
  modifiersBitmask,
  resolveKeyDescriptor,
  selectAllModifiers,
  type KeyModifier,
} from './cdp-keys.mjs';
import {
  snapshotAccessibilityTree,
  type BrowserRefTarget,
  type CdpCommandSender,
} from './cdp-snapshot.mjs';

export { snapshotAccessibilityTree, type BrowserRefTarget, type CdpCommandSender };

export interface CdpExpectedInputHooks {
  expectedKey?: (input: Input) => boolean;
  expectedMouse?: (input: MouseInputEvent) => boolean;
}

export interface CdpTabSession {
  readonly refs: Map<string, BrowserRefTarget>;
  readonly hooks: CdpExpectedInputHooks;
  readonly send: CdpCommandSender;
  readonly zoomFactor?: () => number;
  readonly platform?: NodeJS.Platform;
}

const coordinate = z.number().finite();
const quadTuple = z.tuple([
  coordinate,
  coordinate,
  coordinate,
  coordinate,
  coordinate,
  coordinate,
  coordinate,
  coordinate,
]);
const contentQuadsSchema = z.object({
  quads: z.array(quadTuple),
});
const boxModelSchema = z.object({
  model: z.object({
    content: quadTuple,
  }),
});
const layoutMetricsSchema = z.object({
  cssVisualViewport: z
    .object({
      clientWidth: coordinate,
      clientHeight: coordinate,
    })
    .optional(),
  visualViewport: z
    .object({
      clientWidth: coordinate,
      clientHeight: coordinate,
    })
    .optional(),
});
const resolveNodeSchema = z.object({
  object: z.object({
    objectId: z.string().min(1),
  }),
});
const callFunctionResultSchema = z.object({
  result: z.object({
    value: z.unknown().optional(),
  }),
  exceptionDetails: z.object({ text: z.string().optional() }).optional(),
});
const screenshotSchema = z.object({
  data: z.string().min(1),
});

function isStaleNodeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /Could not find node|No node with given id|Node does not have a layout object|Node is detached/i.test(
    error.message,
  );
}

async function runNodeCommand<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isStaleNodeError(error)) {
      throw new Error('该页面引用已失效或不可见，请重新读取页面。');
    }
    throw error;
  }
}

export async function withExpectedKey<T>(
  hooks: CdpExpectedInputHooks,
  predicate: (input: Input) => boolean,
  work: () => Promise<T>,
): Promise<T> {
  hooks.expectedKey = predicate;
  try {
    return await work();
  } finally {
    hooks.expectedKey = undefined;
  }
}

export async function withExpectedMouse<T>(
  hooks: CdpExpectedInputHooks,
  predicate: (input: MouseInputEvent) => boolean,
  work: () => Promise<T>,
): Promise<T> {
  hooks.expectedMouse = predicate;
  try {
    return await work();
  } finally {
    hooks.expectedMouse = undefined;
  }
}

function matchesCoord(actual: number, expected: number, zoom: number): boolean {
  const tol = Math.max(2, Math.ceil(zoom * 2));
  return Math.abs(actual - expected) <= tol || Math.abs(actual - expected * zoom) <= tol;
}

function quadCenter(
  quad: readonly [number, number, number, number, number, number, number, number],
): {
  x: number;
  y: number;
  area: number;
} {
  const [x1, y1, x2, y2, x3, y3, x4, y4] = quad;
  const xs = [x1, x2, x3, x4];
  const ys = [y1, y2, y3, y4];
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return {
    x: (x1 + x2 + x3 + x4) / 4,
    y: (y1 + y2 + y3 + y4) / 4,
    area: width * height,
  };
}

async function tryResolveNodeObjectId(
  session: Pick<CdpTabSession, 'send'>,
  backendNodeId: number,
): Promise<string | undefined> {
  try {
    const parsed = resolveNodeSchema.safeParse(
      await session.send('DOM.resolveNode', { backendNodeId }),
    );
    return parsed.success ? parsed.data.object.objectId : undefined;
  } catch (error) {
    if (isStaleNodeError(error)) throw error;
    return undefined;
  }
}

async function resolveElementCenter(
  session: Pick<CdpTabSession, 'send'>,
  backendNodeId: number,
  options?: { centerScroll?: boolean },
): Promise<{ x: number; y: number; objectId?: string }> {
  return runNodeCommand(async () => {
    let objectId: string | undefined;
    if (options?.centerScroll) {
      objectId = await tryResolveNodeObjectId(session, backendNodeId);
      if (objectId) {
        try {
          await session.send('Runtime.callFunctionOn', {
            objectId,
            returnByValue: true,
            functionDeclaration: `function() {
              if (typeof this.scrollIntoView === 'function') {
                this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              }
            }`,
          });
        } catch {
          await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
        }
      } else {
        await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
      }
    } else {
      await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    }

    try {
      const parsed = contentQuadsSchema.safeParse(
        await session.send('DOM.getContentQuads', { backendNodeId }),
      );
      if (parsed.success) {
        for (const quad of parsed.data.quads) {
          const center = quadCenter(quad);
          if (center.area > 0) return { x: center.x, y: center.y, objectId };
        }
      }
    } catch (error) {
      if (isStaleNodeError(error)) throw error;
    }

    const { model } = boxModelSchema.parse(
      await session.send('DOM.getBoxModel', { backendNodeId }),
    );
    const center = quadCenter(model.content);
    return { x: center.x, y: center.y, objectId };
  });
}

async function assertElementNotOccluded(
  session: Pick<CdpTabSession, 'send'>,
  objectId: string | undefined,
  x: number,
  y: number,
): Promise<void> {
  if (!objectId) return;
  try {
    const response = callFunctionResultSchema.safeParse(
      await session.send('Runtime.callFunctionOn', {
        objectId,
        returnByValue: true,
        arguments: [{ value: Math.round(x) }, { value: Math.round(y) }],
        functionDeclaration: `function(cx, cy) {
          const hit = document.elementFromPoint(cx, cy);
          if (!hit) return { ok: true };
          if (hit === this || this.contains(hit) || hit.contains(this)) return { ok: true };
          const label = (hit.getAttribute('aria-label') || hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
          return { ok: false, blocker: hit.tagName.toLowerCase() + (label ? ' "' + label + '"' : '') };
        }`,
      }),
    );
    if (!response.success || response.data.exceptionDetails) return;
    const outcome = z
      .union([
        z.object({ ok: z.literal(true) }),
        z.object({ ok: z.literal(false), blocker: z.string() }),
      ])
      .safeParse(response.data.result.value);
    if (outcome.success && !outcome.data.ok) {
      throw new Error(
        `目标元素被页面上的其他元素遮挡（${outcome.data.blocker}），请先关闭弹窗/遮罩或滚动页面后再试。`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('目标元素被页面上的其他元素遮挡')) {
      throw error;
    }
  }
}

async function dispatchExpectedKey(
  session: Pick<CdpTabSession, 'hooks' | 'send'>,
  type: 'rawKeyDown' | 'keyDown' | 'keyUp',
  key: string,
  code: string,
  windowsVirtualKeyCode: number,
  modifiers = 0,
  text?: string,
): Promise<void> {
  await withExpectedKey(
    session.hooks,
    (event) =>
      event.type === (type === 'keyUp' ? 'keyUp' : 'keyDown') &&
      (event.key === key || (key.length === 1 && event.key.toLowerCase() === key.toLowerCase())) &&
      (!code || event.code === code) &&
      event.alt === Boolean(modifiers & 1) &&
      event.control === Boolean(modifiers & 2) &&
      event.meta === Boolean(modifiers & 4) &&
      event.shift === Boolean(modifiers & 8),
    () =>
      session.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode,
        modifiers,
        text,
      }),
  );
}

async function dispatchExpectedMouseMove(
  session: Pick<CdpTabSession, 'hooks' | 'send' | 'zoomFactor'>,
  x: number,
  y: number,
): Promise<void> {
  const zoom = session.zoomFactor?.() ?? 1;
  await withExpectedMouse(
    session.hooks,
    (event) =>
      event.type === 'mouseMove' &&
      matchesCoord(event.x, x, zoom) &&
      matchesCoord(event.y, y, zoom),
    () =>
      session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        buttons: 0,
      }),
  );
}

export async function executeCdpPressKey(
  session: Pick<CdpTabSession, 'hooks' | 'send'>,
  rawKey: string,
  modifiers?: readonly KeyModifier[],
): Promise<void> {
  const desc = resolveKeyDescriptor(rawKey);
  const mask = modifiersBitmask(modifiers);
  const hasCommandModifier = Boolean(mask & (1 | 2 | 4));
  const downType = hasCommandModifier || !desc.text ? 'rawKeyDown' : 'keyDown';
  await dispatchExpectedKey(
    session,
    downType,
    desc.key,
    desc.code,
    desc.windowsVirtualKeyCode,
    mask,
    hasCommandModifier ? undefined : desc.text,
  );
  await dispatchExpectedKey(
    session,
    'keyUp',
    desc.key,
    desc.code,
    desc.windowsVirtualKeyCode,
    mask,
  );
}

export async function executeCdpType(
  session: CdpTabSession,
  targetRef: string | undefined,
  text: string,
  optionsOrSubmit?: boolean | { clear?: boolean; submit?: boolean },
): Promise<void> {
  const target = session.refs.get(targetRef ?? '');
  if (!target) throw new Error('该页面引用已失效，请重新读取页面。');
  if (!target.editable) throw new Error('该元素不可编辑，请选择输入框。');

  const clear = typeof optionsOrSubmit === 'object' ? (optionsOrSubmit.clear ?? true) : true;
  const submit =
    typeof optionsOrSubmit === 'boolean' ? optionsOrSubmit : Boolean(optionsOrSubmit?.submit);

  await runNodeCommand(() => session.send('DOM.focus', { backendNodeId: target.id }));
  if (clear) {
    const selectMask = modifiersBitmask(selectAllModifiers(session.platform));
    await dispatchExpectedKey(session, 'rawKeyDown', 'a', 'KeyA', 65, selectMask);
    await dispatchExpectedKey(session, 'keyUp', 'a', 'KeyA', 65, selectMask);
    if (text.length === 0) {
      await executeCdpPressKey(session, 'Backspace');
    }
  }
  if (text.length > 0) {
    await session.send('Input.insertText', { text });
  }
  if (submit) {
    await executeCdpPressKey(session, 'Enter');
  }
}

export async function executeCdpFillForm(
  session: CdpTabSession,
  fields: readonly {
    readonly target?: string;
    readonly ref?: string;
    readonly value: string;
    readonly clear?: boolean;
  }[],
): Promise<{ filledCount: number }> {
  let filledCount = 0;
  for (const field of fields) {
    const ref = field.target ?? field.ref;
    const target = session.refs.get(ref ?? '');
    if (!target)
      throw new Error(`第 ${filledCount + 1} 项表单引用（${ref ?? ''}）已失效，请重新读取页面。`);
    if (target.role === 'combobox' || target.role === 'listbox') {
      try {
        await executeCdpSelectOption(session, ref, { value: field.value, label: field.value });
        filledCount += 1;
        continue;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('目标元素不是原生下拉选择框')) {
          throw error;
        }
      }
    }
    await executeCdpType(session, ref, field.value, { clear: field.clear });
    filledCount += 1;
  }
  return { filledCount };
}

export async function executeCdpHover(
  session: CdpTabSession,
  targetRef: string | undefined,
): Promise<void> {
  const target = session.refs.get(targetRef ?? '');
  if (!target) throw new Error('该页面引用已失效，请重新读取页面。');

  const { x, y, objectId } = await resolveElementCenter(session, target.id, { centerScroll: true });
  await assertElementNotOccluded(session, objectId, x, y);
  await dispatchExpectedMouseMove(session, x, y);
}

export async function executeCdpClick(
  session: CdpTabSession,
  targetRef: string | undefined,
  optionsOrDouble?: boolean | { doubleClick?: boolean; button?: 'left' | 'right' | 'middle' },
): Promise<void> {
  const target = session.refs.get(targetRef ?? '');
  if (!target) throw new Error('该页面引用已失效，请重新读取页面。');

  const doubleClick =
    typeof optionsOrDouble === 'boolean' ? optionsOrDouble : Boolean(optionsOrDouble?.doubleClick);
  const button = typeof optionsOrDouble === 'object' ? (optionsOrDouble.button ?? 'left') : 'left';
  const pressedButtons = button === 'left' ? 1 : button === 'right' ? 2 : 4;

  const { x, y, objectId } = await resolveElementCenter(session, target.id, { centerScroll: true });
  await assertElementNotOccluded(session, objectId, x, y);
  await dispatchExpectedMouseMove(session, x, y);

  const zoom = session.zoomFactor?.() ?? 1;
  const clicks = doubleClick ? 2 : 1;

  for (let clickCount = 1; clickCount <= clicks; clickCount++) {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await withExpectedMouse(
        session.hooks,
        (event) =>
          event.type === (type === 'mousePressed' ? 'mouseDown' : 'mouseUp') &&
          event.button === button &&
          matchesCoord(event.x, x, zoom) &&
          matchesCoord(event.y, y, zoom),
        () =>
          session.send('Input.dispatchMouseEvent', {
            type,
            x,
            y,
            button,
            clickCount,
            buttons: type === 'mousePressed' ? pressedButtons : 0,
          }),
      );
    }
  }
}

export async function executeCdpScroll(
  session: CdpTabSession,
  options: {
    direction?: 'up' | 'down' | 'left' | 'right';
    amount?: number;
    targetRef?: string;
  },
): Promise<void> {
  const direction = options.direction ?? 'down';
  const amount = options.amount ?? 600;
  let x = 400;
  let y = 300;

  if (options.targetRef) {
    const target = session.refs.get(options.targetRef);
    if (!target) throw new Error('该页面引用已失效，请重新读取页面。');
    const center = await resolveElementCenter(session, target.id);
    x = center.x;
    y = center.y;
  } else {
    try {
      const metrics = layoutMetricsSchema.safeParse(await session.send('Page.getLayoutMetrics'));
      const viewport = metrics.success
        ? (metrics.data.cssVisualViewport ?? metrics.data.visualViewport)
        : undefined;
      if (viewport && viewport.clientWidth > 0 && viewport.clientHeight > 0) {
        x = Math.round(viewport.clientWidth / 2);
        y = Math.round(viewport.clientHeight / 2);
      }
    } catch {
      // Fall back to default viewport coordinates.
    }
  }

  const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
  const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
  const zoom = session.zoomFactor?.() ?? 1;

  await withExpectedMouse(
    session.hooks,
    (event) =>
      event.type === 'mouseWheel' &&
      matchesCoord(event.x, x, zoom) &&
      matchesCoord(event.y, y, zoom),
    () =>
      session.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX,
        deltaY,
      }),
  );
}

export async function executeCdpSelectOption(
  session: Pick<CdpTabSession, 'refs' | 'send'>,
  targetRef: string | undefined,
  options: { value?: string; label?: string },
): Promise<{ selectedValue: string; selectedLabel: string }> {
  const target = session.refs.get(targetRef ?? '');
  if (!target) throw new Error('该页面引用已失效，请重新读取页面。');

  const resolved = await runNodeCommand(async () =>
    resolveNodeSchema.parse(await session.send('DOM.resolveNode', { backendNodeId: target.id })),
  );

  const response = callFunctionResultSchema.parse(
    await session.send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      returnByValue: true,
      arguments: [{ value: options.value ?? null }, { value: options.label ?? null }],
      functionDeclaration: `function(targetValue, targetLabel) {
        if (!(this instanceof HTMLSelectElement)) {
          return { error: '目标元素不是原生下拉选择框（<select>）。' };
        }
        const opts = Array.from(this.options);
        let match = null;
        if (targetValue !== null) {
          match = opts.find((o) => o.value === targetValue) ?? null;
        }
        if (!match && targetLabel !== null) {
          const trimmed = String(targetLabel).trim();
          match = opts.find((o) => o.text.trim() === trimmed || o.label.trim() === trimmed)
            ?? opts.find((o) => o.text.trim().toLowerCase() === trimmed.toLowerCase())
            ?? null;
        }
        if (!match) {
          return { error: '未找到匹配的下拉选项。' };
        }
        if (match.disabled) {
          return { error: '目标下拉选项处于禁用状态。' };
        }
        this.value = match.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { selectedValue: match.value, selectedLabel: match.text.trim() };
      }`,
    }),
  );

  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || '选择下拉选项失败。');
  }
  const outcome = z
    .union([
      z.object({ error: z.string() }),
      z.object({ selectedValue: z.string(), selectedLabel: z.string() }),
    ])
    .parse(response.result.value);
  if ('error' in outcome) throw new Error(outcome.error);
  return outcome;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function executeCdpWaitFor(
  session: Pick<CdpTabSession, 'send'>,
  options: {
    text?: string;
    textGone?: string;
    timeoutMs?: number;
    signal: AbortSignal;
  },
): Promise<{ text: string }> {
  const { text, textGone, signal } = options;
  const limitMs = options.timeoutMs ?? (text || textGone ? 10_000 : 1_000);

  if (!text && !textGone) {
    await abortableDelay(limitMs, signal);
    return { text: `已等待 ${limitMs} 毫秒。` };
  }

  const deadline = Date.now() + limitMs;
  while (true) {
    signal.throwIfAborted();
    const evaluated = callFunctionResultSchema.parse(
      await session.send('Runtime.evaluate', {
        expression:
          '(document.body && (document.body.innerText || document.body.textContent)) || ""',
        returnByValue: true,
      }),
    );
    const bodyText = typeof evaluated.result.value === 'string' ? evaluated.result.value : '';
    const hasExpected = text === undefined || bodyText.includes(text);
    const isGone = textGone === undefined || !bodyText.includes(textGone);
    if (hasExpected && isGone) {
      return { text: '等待条件已满足。' };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`在 ${limitMs} 毫秒内未满足等待条件。`);
    }
    await abortableDelay(Math.min(150, remaining), signal);
  }
}

export interface PendingBrowserDialog {
  readonly type: string;
  readonly message: string;
  readonly url: string;
  readonly defaultPrompt?: string;
}

const dialogOpeningSchema = z.object({
  type: z.string().min(1),
  message: z.string(),
  url: z.string().optional(),
  defaultPrompt: z.string().optional(),
});

export function parseJavascriptDialogOpening(params: unknown): PendingBrowserDialog | undefined {
  const parsed = dialogOpeningSchema.safeParse(params);
  if (!parsed.success) return undefined;
  return {
    type: parsed.data.type,
    message: parsed.data.message,
    url: parsed.data.url ?? '',
    defaultPrompt: parsed.data.defaultPrompt,
  };
}

export function formatPendingDialogNotice(
  dialog: PendingBrowserDialog,
  triggeredByAction: boolean,
): string {
  const promptPart =
    dialog.defaultPrompt !== undefined && dialog.defaultPrompt.length > 0
      ? `，默认输入：${JSON.stringify(dialog.defaultPrompt)}`
      : '';
  const prefix = triggeredByAction ? '网页操作已触发浏览器弹窗' : '当前页面存在未处理的浏览器弹窗';
  return `${prefix}（类型：${dialog.type}，内容：${JSON.stringify(dialog.message)}${promptPart}）。请根据任务需要调用 browser_handle_dialog 选择确认或取消。`;
}

export async function executeCdpScreenshot(
  session: Pick<CdpTabSession, 'send'>,
  options?: { fullPage?: boolean },
): Promise<{ png: string }> {
  const result = screenshotSchema.parse(
    await session.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: Boolean(options?.fullPage),
    }),
  );
  return { png: result.data };
}
