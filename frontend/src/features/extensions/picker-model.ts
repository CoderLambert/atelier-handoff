/**
 * @file 定义扩展和文件补全的候选、键盘动作与草稿替换。
 * @implementation 从光标令牌和有效权限模式选择候选，保留草稿独立保存的运行偏好。
 * @updated 2026-11-27T18:34:46+08:00
 */
import { getTranslator } from '@/i18n';
import type { SkillInheritanceItem } from '@shared/skill-inheritance';
import type { Draft, Extension, ExtensionSelection, Mode } from '@shared/types';
import { canSelectSkill } from './inheritance-model';

export function selectCompletionKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>,
  open: boolean,
  optionCount: number,
) {
  if (!open || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  if (event.key === 'Escape') return 'dismiss';
  if (!optionCount) return;
  switch (event.key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'previous';
    case 'Enter':
    case 'Tab':
      return 'choose';
  }
}

export interface CompletionTrigger {
  start: number;
  end: number;
  symbol: '/' | '#' | '@';
  query: string;
  word: string;
}
type CompletionSkill = SkillInheritanceItem & { kind: 'skill' };

export interface CompletionChoice {
  item: Extension | CompletionSkill;
  label: string;
  description: string;
  kind: string;
  skillSource?: SkillInheritanceItem['source'];
  tools?: string[];
}
export function inCode(text: string) {
  let fence: { marker: string; length: number } | undefined;
  let ticks = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        match &&
        match[1]![0] === fence.marker &&
        match[1]!.length >= fence.length &&
        !match[2]!.trim()
      )
        fence = undefined;
      continue;
    }
    if (match && !ticks) {
      fence = { marker: match[1]![0]!, length: match[1]!.length };
      continue;
    }
    for (const run of line.matchAll(/(?<!\\)(`+)/g)) {
      if (!ticks) ticks = run[0].length;
      else if (ticks === run[0].length) ticks = 0;
    }
  }
  return Boolean(fence) || ticks !== 0 || /^(?: {4}|\t)/.test(lines.at(-1) ?? '');
}
export function triggerAt(
  value: string,
  caret: number | null,
  selectionEnd: number | null,
): CompletionTrigger | null {
  if (caret == null || caret !== selectionEnd) return null;
  let start = caret;
  let end = caret;
  while (start > 0 && !/\s/u.test(value[start - 1]!)) start--;
  while (end < value.length && !/\s/u.test(value[end]!)) end++;
  const word = value.slice(start, end);
  const before = value.slice(start, caret);
  if (!/^(?:\/[\p{L}\p{N}_:-]*|#[\p{L}\p{N}_:.-]*(?:\/[\p{L}\p{N}_:.-]*)?|@[^\s@]*)$/u.test(word))
    return null;
  if (!before || inCode(value.slice(0, start))) return null;
  return {
    start,
    end,
    symbol: word[0] as '/' | '#' | '@',
    query: before.slice(1).toLocaleLowerCase(),
    word,
  };
}
export function allowedTools(item: Extension, mode: Mode) {
  if (item.kind !== 'mcp' || !item.enabled || item.status !== 'connected') return [];
  const discovered = new Set(item.tools.map((tool) => tool.name));
  return item.allowedTools.filter(
    (tool) => discovered.has(tool.name) && (mode !== 'readonly' || tool.access === 'read'),
  );
}
export function completionSkills(items: readonly SkillInheritanceItem[]) {
  // The session preview owns eligibility (including host opt-in and agent scope).
  return items.filter(canSelectSkill).map((item): CompletionSkill => ({ ...item, kind: 'skill' }));
}

export function choices(
  items: (Extension | CompletionSkill)[],
  trigger: CompletionTrigger,
  text: string,
  mode: Mode,
): CompletionChoice[] {
  const t = getTranslator('extensions');
  const rows: CompletionChoice[] = [];
  for (const item of items) {
    if ('effective' in item) {
      if (trigger.symbol !== '/' || !canSelectSkill(item) || !/^[\p{L}\p{N}_:-]+$/u.test(item.name))
        continue;
      rows.push({
        item,
        label: `/${item.name}`,
        description: item.description,
        kind: t('common.skills'),
        skillSource: item.source,
      });
      continue;
    }
    if (!item.enabled || (item.kind !== 'mcp' && !item.supported)) continue;
    if (trigger.symbol === '/') {
      if (item.kind === 'mcp' || item.kind === 'skill' || !/^[\p{L}\p{N}_:-]+$/u.test(item.name))
        continue;
      if (item.kind === 'command' && text.slice(0, trigger.start).trim()) continue;
      rows.push({
        item,
        label: `/${item.name}`,
        description: item.description,
        kind: t('common.commands'),
      });
    } else if (item.kind === 'mcp') {
      const allowed = allowedTools(item, mode);
      if (!allowed.length) continue;
      rows.push({
        item,
        label: `#${item.name}`,
        description: t('picker.allowedToolsCount', { count: allowed.length }),
        kind: t('common.mcp'),
        tools: allowed.map((tool) => tool.name),
      });
      const descriptions = new Map(item.tools.map((tool) => [tool.name, tool.description]));
      for (const tool of allowed)
        rows.push({
          item,
          label: `#${item.name}/${tool.name}`,
          description: descriptions.get(tool.name) ?? '',
          kind: tool.access === 'read' ? t('common.readonlyTool') : t('picker.approvalTool'),
          tools: [tool.name],
        });
    }
  }
  return rows
    .filter((row) =>
      `${row.label.slice(1)} ${row.description}`.toLocaleLowerCase().includes(trigger.query),
    )
    .sort(
      (a, b) =>
        Number(b.label.slice(1).toLocaleLowerCase().startsWith(trigger.query)) -
        Number(a.label.slice(1).toLocaleLowerCase().startsWith(trigger.query)),
    );
}
export function chooseExtension(
  draft: Draft,
  trigger: CompletionTrigger,
  row: CompletionChoice,
  selectionMode = draft.mode,
): { draft: Draft; caret: number } {
  const latest = row.item;
  const selections = [...(draft.extensionSelections ?? [])];
  if (latest.kind !== 'command') {
    const index = selections.findIndex((selection) => selection.id === latest.id);
    const previous = selections[index];
    const selection: ExtensionSelection = { id: latest.id, version: latest.version };
    if (latest.kind === 'mcp') {
      const allowed = new Set(allowedTools(latest, selectionMode).map((tool) => tool.name));
      const oldTools =
        previous?.version === latest.version
          ? (previous.tools ?? []).filter((name) => allowed.has(name))
          : [];
      selection.tools = [...new Set([...oldTools, ...(row.tools ?? [])])];
    }
    if (index < 0) selections.push(selection);
    else selections[index] = selection;
  }
  const replacement = latest.kind === 'command' ? `/${latest.name} ` : '';
  return {
    draft: {
      ...draft,
      text: draft.text.slice(0, trigger.start) + replacement + draft.text.slice(trigger.end),
      ...(latest.kind !== 'command' ? { extensionSelections: selections } : {}),
    },
    caret: trigger.start + replacement.length,
  };
}
export function chooseFile(
  draft: Draft,
  trigger: CompletionTrigger,
  file: { path: string; name?: string },
): { draft: Draft; caret: number } {
  const cleanPath = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
  const replacement = `@${cleanPath} `;
  const before = draft.text.slice(0, trigger.start);
  const after = draft.text.slice(trigger.end);
  return {
    draft: {
      ...draft,
      text: before + replacement + after,
    },
    caret: trigger.start + replacement.length,
  };
}
export function chooseDirectory(
  draft: Draft,
  trigger: CompletionTrigger,
  dir: { path: string },
): { draft: Draft; caret: number } {
  const cleanPath = dir.path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const replacement = `@${cleanPath}/`;
  const before = draft.text.slice(0, trigger.start);
  const after = draft.text.slice(trigger.end);
  return {
    draft: {
      ...draft,
      text: before + replacement + after,
    },
    caret: trigger.start + replacement.length,
  };
}
export function selectionReason(
  item: Extension | undefined,
  selection: ExtensionSelection,
  mode: Mode,
  loaded: boolean,
) {
  const t = getTranslator('extensions');
  if (!item) return loaded ? t('picker.unavailable') : '';
  if (!item.enabled) return t('common.disabled');
  if (item.kind !== 'mcp' && !item.supported) return t('picker.incompatible');
  if (item.version !== selection.version) return t('picker.changed');
  if (item.kind === 'skill' && item.userInvocable === false)
    return t('extensions.manualUnsupported');
  if (item.kind === 'mcp') {
    const available = new Set(allowedTools(item, mode).map((tool) => tool.name));
    if (!available.size || selection.tools?.some((name) => !available.has(name)))
      return t('picker.reselect');
  }
  return '';
}
