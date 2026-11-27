/**
 * @file 封装原生浏览器 CDP 无障碍树重建、噪声剪枝、状态提取与紧凑树形快照输出。
 * @implementation 保留语义层级与关键控件状态，剔除冗余容器和重复文本节点，按需支持局部子树快照与节点/字符预算控制。
 * @updated 2026-11-27T23:30:00+08:00
 */
import { z } from 'zod';

export interface BrowserRefTarget {
  readonly id: number;
  readonly editable: boolean;
  readonly role: string;
}

export type CdpCommandSender = (name: string, params?: object) => Promise<unknown>;

const axValueSchema = z.object({ value: z.unknown().optional() });
const axPropertySchema = z.object({
  name: z.string(),
  value: axValueSchema,
});
const axNodeSchema = z.object({
  nodeId: z.string().optional(),
  ignored: z.boolean().optional(),
  backendDOMNodeId: z.int().positive().optional(),
  role: z.object({ value: z.string() }).optional(),
  name: axValueSchema.optional(),
  value: axValueSchema.optional(),
  description: axValueSchema.optional(),
  properties: z.array(axPropertySchema).optional(),
  childIds: z.array(z.string()).optional(),
});
const accessibilityTreeSchema = z.object({
  nodes: z.array(axNodeSchema),
});

const snapshotMetricsSchema = z.object({
  cssVisualViewport: z
    .object({
      pageY: z.number().finite(),
      clientWidth: z.number().finite(),
      clientHeight: z.number().finite(),
    })
    .optional(),
  visualViewport: z
    .object({
      pageY: z.number().finite(),
      clientWidth: z.number().finite(),
      clientHeight: z.number().finite(),
    })
    .optional(),
  cssContentSize: z
    .object({
      height: z.number().finite(),
    })
    .optional(),
  contentSize: z
    .object({
      height: z.number().finite(),
    })
    .optional(),
});

type AxNode = z.infer<typeof axNodeSchema>;

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'listbox',
  'option',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'spinbutton',
  'treeitem',
]);

const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

const STRUCTURAL_ROLES = new Set([
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'form',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'table',
  'grid',
  'rowgroup',
  'row',
  'cell',
  'columnheader',
  'rowheader',
  'list',
  'listitem',
  'tablist',
  'tabpanel',
  'menu',
  'menubar',
  'tree',
  'heading',
  'article',
  'section',
  'toolbar',
  'group',
]);

const HOIST_ROLES = new Set([
  'RootWebArea',
  'WebArea',
  'generic',
  'none',
  'presentation',
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell',
]);

const DROP_ROLES = new Set(['InlineTextBox', 'LineBreak']);

const DEFAULT_MAX_NODES = 350;
const MAX_OUTPUT_CHARS = 18_000;
const MAX_NAME_CHARS = 240;
const MAX_VALUE_CHARS = 200;

interface RenderedNode {
  readonly role: string;
  readonly name: string;
  readonly backendDOMNodeId?: number;
  readonly editable: boolean;
  readonly interactive: boolean;
  readonly attrs: readonly string[];
  readonly children: readonly RenderedNode[];
}

function readString(value: unknown, maxLen: number): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function propertyMap(node: AxNode): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!node.properties) return map;
  for (const prop of node.properties) {
    map.set(prop.name, prop.value.value);
  }
  return map;
}

function isEditableNode(role: string, props: Map<string, unknown>): boolean {
  if (props.get('readonly') === true) return false;
  if (EDITABLE_ROLES.has(role)) return true;
  const editable = props.get('editable');
  return editable === true || (typeof editable === 'string' && editable !== 'false' && editable !== 'none');
}

function extractAttrs(node: AxNode, props: Map<string, unknown>): string[] {
  const attrs: string[] = [];
  const val = readString(node.value?.value, MAX_VALUE_CHARS);
  if (val) attrs.push(`value=${JSON.stringify(val)}`);

  const checked = props.get('checked');
  if (checked === true || checked === 'true') attrs.push('checked');
  else if (checked === 'mixed') attrs.push('checked=mixed');

  if (props.get('selected') === true) attrs.push('selected');

  const expanded = props.get('expanded');
  if (expanded === true) attrs.push('expanded');
  else if (expanded === false) attrs.push('collapsed');

  if (props.get('disabled') === true) attrs.push('disabled');
  if (props.get('focused') === true) attrs.push('focused');
  if (props.get('required') === true) attrs.push('required');
  if (props.get('readonly') === true) attrs.push('readonly');

  const level = props.get('level');
  if (typeof level === 'number' && Number.isFinite(level)) attrs.push(`level=${level}`);

  const placeholder = readString(props.get('placeholder'), 120);
  if (placeholder) attrs.push(`placeholder=${JSON.stringify(placeholder)}`);

  return attrs;
}

function buildRenderedTree(
  node: AxNode,
  nodeMap: Map<string, AxNode>,
  visited: Set<string>,
  parentName: string,
  parentInteractiveOrHeading: boolean,
): RenderedNode[] {
  if (node.nodeId) {
    if (visited.has(node.nodeId)) return [];
    visited.add(node.nodeId);
  }

  const role = node.role?.value ?? '';
  if (DROP_ROLES.has(role)) return [];

  const name = readString(node.name?.value, MAX_NAME_CHARS);
  const props = propertyMap(node);
  const interactive = INTERACTIVE_ROLES.has(role);
  const editable = isEditableNode(role, props);
  const isHeading = role === 'heading';
  const attrs = extractAttrs(node, props);

  const childNodes: RenderedNode[] = [];
  if (node.childIds) {
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (!child) continue;
      childNodes.push(
        ...buildRenderedTree(
          child,
          nodeMap,
          visited,
          name || parentName,
          interactive || isHeading,
        ),
      );
    }
  }

  if (node.ignored || HOIST_ROLES.has(role)) {
    return childNodes;
  }

  // Drop StaticText leaf when its text duplicates the enclosing interactive/heading label.
  if (role === 'StaticText' && childNodes.length === 0) {
    if (!name) return [];
    if (parentInteractiveOrHeading && parentName && name === parentName) return [];
    return [
      {
        role: 'text',
        name,
        backendDOMNodeId: node.backendDOMNodeId,
        editable: false,
        interactive: false,
        attrs: [],
        children: [],
      },
    ];
  }

  const hasContent = Boolean(name) || attrs.length > 0 || interactive || editable;
  const isStructural = STRUCTURAL_ROLES.has(role);

  if (!hasContent && childNodes.length === 0) return [];
  if (!hasContent && !isStructural) return childNodes;

  // Collapse unnamed structural container with only a single child of the same role.
  if (isStructural && !name && attrs.length === 0 && childNodes.length === 1 && childNodes[0]?.role === role) {
    return childNodes;
  }

  return [
    {
      role: role || 'element',
      name,
      backendDOMNodeId: node.backendDOMNodeId,
      editable,
      interactive,
      attrs,
      children: childNodes,
    },
  ];
}

function countRenderedNodes(nodes: readonly RenderedNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1 + countRenderedNodes(node.children);
  }
  return total;
}

export async function snapshotAccessibilityTree(options: {
  send: CdpCommandSender;
  refs: Map<string, BrowserRefTarget>;
  revision: number;
  url: string;
  title: string;
  rootRef?: string;
  maxNodes?: number;
  assertTabOwned?: () => void;
}): Promise<{ text: string }> {
  const { send, refs, revision, url, title, rootRef, assertTabOwned } = options;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;

  let rootBackendNodeId: number | undefined;
  if (rootRef) {
    const existing = refs.get(rootRef);
    if (!existing) throw new Error('该页面引用已失效，请重新读取页面。');
    rootBackendNodeId = existing.id;
  }

  const { nodes } = accessibilityTreeSchema.parse(await send('Accessibility.getFullAXTree'));
  assertTabOwned?.();

  const hasIds = nodes.some((node) => typeof node.nodeId === 'string');
  let renderedRoots: RenderedNode[] = [];

  if (hasIds) {
    const nodeMap = new Map<string, AxNode>();
    const childIds = new Set<string>();
    for (const node of nodes) {
      if (node.nodeId) nodeMap.set(node.nodeId, node);
      if (node.childIds) {
        for (const cid of node.childIds) childIds.add(cid);
      }
    }

    let roots: AxNode[];
    if (rootBackendNodeId !== undefined) {
      const targetRoot = nodes.find((node) => node.backendDOMNodeId === rootBackendNodeId);
      if (!targetRoot) throw new Error('该页面引用已失效，请重新读取页面。');
      roots = [targetRoot];
    } else {
      roots = nodes.filter((node) => node.nodeId && !childIds.has(node.nodeId));
      if (roots.length === 0 && nodes[0]) roots = [nodes[0]];
    }

    const visited = new Set<string>();
    for (const root of roots) {
      renderedRoots.push(...buildRenderedTree(root, nodeMap, visited, '', false));
    }
  } else {
    // Graceful fallback for flat mock node arrays without nodeId/childIds.
    const flatNodes =
      rootBackendNodeId !== undefined
        ? nodes.filter((node) => node.backendDOMNodeId === rootBackendNodeId)
        : nodes;
    if (rootBackendNodeId !== undefined && flatNodes.length === 0) {
      throw new Error('该页面引用已失效，请重新读取页面。');
    }
    const visited = new Set<string>();
    for (const node of flatNodes) {
      renderedRoots.push(...buildRenderedTree(node, new Map(), visited, '', false));
    }
  }

  refs.clear();
  const totalNodes = countRenderedNodes(renderedRoots);
  const urlLine = `url: ${url}`;
  const titleLine = `title: ${title}`;
  const lines: string[] = [urlLine, titleLine];
  let charCount = urlLine.length + titleLine.length + 2;

  try {
    const metrics = snapshotMetricsSchema.safeParse(await send('Page.getLayoutMetrics'));
    if (metrics.success) {
      const vp = metrics.data.cssVisualViewport ?? metrics.data.visualViewport;
      const content = metrics.data.cssContentSize ?? metrics.data.contentSize;
      if (vp && vp.clientWidth > 0 && vp.clientHeight > 0) {
        const totalH = Math.max(Math.round(content?.height ?? vp.clientHeight), Math.round(vp.clientHeight));
        const vpLine = `viewport: ${Math.round(vp.clientWidth)}x${Math.round(vp.clientHeight)} scroll: ${Math.round(vp.pageY)}/${totalH}`;
        lines.push(vpLine);
        charCount += vpLine.length + 1;
      }
    }
  } catch {
    // Layout metrics are optional; proceed with accessibility tree output.
  }
  let emittedNodes = 0;
  let refCounter = 0;
  let truncated = false;

  const visit = (node: RenderedNode, depth: number): void => {
    if (truncated) return;
    if (emittedNodes >= maxNodes) {
      truncated = true;
      return;
    }

    const indent = '  '.repeat(depth);
    const parts: string[] = [`${indent}- ${node.role}`];
    if (node.name) parts.push(JSON.stringify(node.name));

    const shouldAssignRef =
      node.backendDOMNodeId !== undefined &&
      (node.interactive || node.editable || STRUCTURAL_ROLES.has(node.role) || node.role === 'element');

    if (shouldAssignRef && node.backendDOMNodeId !== undefined) {
      const ref = `r${revision}-${++refCounter}`;
      refs.set(ref, {
        id: node.backendDOMNodeId,
        editable: node.editable,
        role: node.role,
      });
      parts.push(`[ref=${ref}]`);
    }

    for (const attr of node.attrs) {
      parts.push(`[${attr}]`);
    }

    const line = parts.join(' ');
    if (charCount + line.length + 1 > MAX_OUTPUT_CHARS && emittedNodes > 0) {
      truncated = true;
      return;
    }

    lines.push(line);
    charCount += line.length + 1;
    emittedNodes += 1;

    for (const child of node.children) {
      visit(child, depth + 1);
      if (truncated) return;
    }
  };

  for (const root of renderedRoots) {
    visit(root, 0);
    if (truncated) break;
  }

  if (truncated) {
    lines.push(
      `(truncated: showing ${emittedNodes} of ${totalNodes} nodes; pass rootRef to inspect a subtree or scroll to view more)`,
    );
  } else if (emittedNodes === 0) {
    lines.push('(no visible accessibility elements)');
  }

  return { text: lines.join('\n') };
}
