/**
 * @file 编排会话 Skill 查询、策略更新和草稿选择。
 * @implementation 按弹窗与草稿状态启用查询，区分现有及缺失选择，并在数据可用时更新草稿。
 * @updated 2026-11-26T00:06:59+08:00
 */
import { useState } from 'react';
import type { Draft, ExtensionSelection } from '@shared/types';
import { useSkillInheritance } from '@/use-query/skill-inheritance/use-skill-inheritance';
import { useUpdateSkillInheritance } from '@/use-query/skill-inheritance/use-update-skill-inheritance';
import { addDraftSkill, removeDraftSkill } from './inheritance-model';

export function useSessionSkills({
  projectId,
  sessionId,
  native,
  selections,
  disabled,
  onDraftChange,
}: {
  projectId: string;
  sessionId: string;
  native: boolean;
  selections?: ExtensionSelection[];
  disabled: boolean;
  onDraftChange: (change: (draft: Draft) => Draft) => void;
}) {
  const [open, setOpen] = useState(false);
  const scope = { type: 'session', projectId, sessionId, native } as const;
  const query = useSkillInheritance(scope, open || Boolean(selections?.length));
  const update = useUpdateSkillInheritance(scope);
  const items = query.data?.items ?? [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const draftSkills = selections?.filter(({ id }) => byId.has(id)) ?? [];
  // The existing picker writes an explicit list of tool names for MCP selections.
  const missing = query.isSuccess
    ? selections?.filter(({ id, tools }) => !tools && !byId.has(id)) ?? []
    : [];
  const dialogSelectionIds = new Set(draftSkills.map(({ id }) => id));

  return {
    open,
    setOpen,
    query,
    update,
    items,
    byId,
    draftSkills,
    missing,
    dialogSelectionIds,
    add: (id: string) => {
      const item = byId.get(id);
      if (item && !disabled && !update.saving && query.isSuccess && !query.isFetching) {
        onDraftChange((draft) => addDraftSkill(draft, item));
      }
    },
    remove: (id: string) => {
      if (!disabled) onDraftChange((draft) => removeDraftSkill(draft, id));
    },
  };
}
