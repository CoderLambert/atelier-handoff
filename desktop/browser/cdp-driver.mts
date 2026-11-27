/**
 * @file 封装原生浏览器 CDP 无障碍树读取与键鼠输入命令驱动。
 * @implementation 通过显式 withExpectedKey/withExpectedMouse 作用域守卫放行当前由控制器派发的单次键鼠输入，确保异常退出时总是清理拦截钩子。
 * @updated 2026-11-27T22:00:00+08:00
 */
import type { Input, MouseInputEvent } from 'electron';
import { z } from 'zod';

export interface BrowserRefTarget {
  readonly id: number;
  readonly editable: boolean;
}

export interface CdpExpectedInputHooks {
  expectedKey?: (input: Input) => boolean;
  expectedMouse?: (input: MouseInputEvent) => boolean;
}

export type CdpCommandSender = (name: string, params?: object) => Promise<unknown>;

export interface CdpTabSession {
  readonly refs: Map<string, BrowserRefTarget>;
  readonly hooks: CdpExpectedInputHooks;
  readonly send: CdpCommandSender;
}

const accessibilityTreeSchema = z.object({
  nodes: z.array(
    z.object({
      ignored: z.boolean().optional(),
      backendDOMNodeId: z.int().positive().optional(),
      name: z.object({ value: z.unknown() }).optional(),
      role: z.object({ value: z.string() }).optional(),
    }),
  ),
});

const coordinate = z.number().finite();
const boxModelSchema = z.object({
  model: z.object({
    content: z.tuple([
      coordinate,
      coordinate,
      coordinate,
      coordinate,
      coordinate,
      coordinate,
      coordinate,
      coordinate,
    ]),
  }),
});

const INTERACTIVE_ROLES = ['button', 'link', 'textbox', 'searchbox', 'checkbox', 'combobox'];
const EDITABLE_ROLES = ['textbox', 'searchbox'];

export async function withExpectedKey<T>(
  hooks: CdpExpectedInputHooks,
  predicate: (input: Input) => boolean,
  work: () => Promise<T>,
): Promise<T> {
  // Electron's before-input hooks also receive CDP events. Permit a single
  // matching event while the controller sends each approved input command.
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

export async function snapshotAccessibilityTree(options: {
  send: CdpCommandSender;
  refs: Map<string, BrowserRefTarget>;
  revision: number;
  url: string;
  title: string;
  assertTabOwned?: () => void;
}): Promise<{ text: string }> {
  const { send, refs, revision, url, title, assertTabOwned } = options;
  const { nodes } = accessibilityTreeSchema.parse(await send('Accessibility.getFullAXTree'));
  assertTabOwned?.();
  refs.clear();

  const rows = nodes
    .filter(
      (node) =>
        !node.ignored &&
        (node.name?.value ||
          (node.backendDOMNodeId && EDITABLE_ROLES.includes(node.role?.value ?? ''))),
    )
    .sort(
      (a, b) =>
        Number(INTERACTIVE_ROLES.includes(b.role?.value ?? '')) -
        Number(INTERACTIVE_ROLES.includes(a.role?.value ?? '')),
    )
    .slice(0, 200)
    .map((node, index) => {
      const ref = `r${revision}-${index + 1}`;
      const role = node.role?.value || '';
      if (node.backendDOMNodeId) {
        refs.set(ref, {
          id: node.backendDOMNodeId,
          editable: EDITABLE_ROLES.includes(role),
        });
      }
      return {
        ref: node.backendDOMNodeId ? ref : undefined,
        role,
        name: String(node.name?.value ?? '').slice(0, 300),
      };
    });

  return { text: JSON.stringify({ url, title, elements: rows }) };
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
      event.key === key &&
      event.code === code &&
      event.control === (modifiers === 2),
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

export async function executeCdpType(
  session: CdpTabSession,
  targetRef: string | undefined,
  text: string,
  submit?: boolean,
): Promise<void> {
  const target = session.refs.get(targetRef ?? '');
  if (!target) throw new Error('该页面引用已失效，请重新读取页面。');
  if (!target.editable) throw new Error('请输入有效的文本。');

  await session.send('DOM.focus', { backendNodeId: target.id });
  await dispatchExpectedKey(session, 'rawKeyDown', 'a', 'KeyA', 65, 2);
  await dispatchExpectedKey(session, 'keyUp', 'a', 'KeyA', 65, 2);
  await session.send('Input.insertText', { text });
  if (submit) {
    await dispatchExpectedKey(session, 'keyDown', 'Enter', 'Enter', 13, 0, '\r');
    await dispatchExpectedKey(session, 'keyUp', 'Enter', 'Enter', 13);
  }
}

export async function executeCdpClick(
  session: CdpTabSession,
  targetRef: string | undefined,
  doubleClick?: boolean,
): Promise<void> {
  const target = session.refs.get(targetRef ?? '');
  if (!target) throw new Error('该页面引用已失效，请重新读取页面。');

  await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.id });
  const { model } = boxModelSchema.parse(
    await session.send('DOM.getBoxModel', { backendNodeId: target.id }),
  );
  const [x1, y1, , , x3, y3] = model.content;
  const x = (x1 + x3) / 2;
  const y = (y1 + y3) / 2;
  const clicks = doubleClick ? 2 : 1;

  for (let clickCount = 1; clickCount <= clicks; clickCount++) {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await withExpectedMouse(
        session.hooks,
        (event) =>
          event.type === (type === 'mousePressed' ? 'mouseDown' : 'mouseUp') &&
          event.button === 'left' &&
          Math.abs(event.x - x) < 1 &&
          Math.abs(event.y - y) < 1,
        () =>
          session.send('Input.dispatchMouseEvent', {
            type,
            x,
            y,
            button: 'left',
            clickCount,
            buttons: type === 'mousePressed' ? 1 : 0,
          }),
      );
    }
  }
}
