/**
 * @file 管理会话 Skill 的草稿选择规则。
 * @implementation 根据有效策略、版本和数量限制增删选择，识别运行记录，并合并选择器与会话弹窗的选择。
 * @updated 2026-11-26T00:06:59+08:00
 */
import type { SkillInheritanceItem } from '@shared/skill-inheritance';
import type { Draft, ExtensionSelection, UsedExtension } from '@shared/types';

export const draftSelectionLimit = 12; // Existing extensionSelections request limit.

export function canSelectSkill(item: SkillInheritanceItem) {
  return item.effective !== 'off' && item.manual;
}

export function canRestrictSkill(item: SkillInheritanceItem) {
  return item.effective !== 'off' || item.reason === 'session-off';
}

export function addDraftSkill(draft: Draft, item: SkillInheritanceItem): Draft {
  const selections = draft.extensionSelections ?? [];
  if (
    !canSelectSkill(item) ||
    selections.length >= draftSelectionLimit ||
    selections.some(({ id }) => id === item.id)
  ) {
    return draft;
  }
  return { ...draft, extensionSelections: [...selections, { id: item.id, version: item.version }] };
}

export function removeDraftSkill(draft: Draft, id: string): Draft {
  return {
    ...draft,
    extensionSelections: draft.extensionSelections?.filter((item) => item.id !== id),
  };
}

export function isCurrentSkillSelection(selection: ExtensionSelection, item: SkillInheritanceItem) {
  return selection.version === item.version && canSelectSkill(item);
}

export function recordedOnRun(item: SkillInheritanceItem, extensions?: UsedExtension[]) {
  return extensions?.some(
    ({ id, version, kind }) => kind === 'skill' && id === item.id && version === item.version,
  );
}
