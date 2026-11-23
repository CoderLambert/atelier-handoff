/**
 * @file 展示当前运行及历史消息中的任务清单。
 * @implementation 从运行快照派生完成数量与三种任务状态，用共享按钮控制清单展开。
 * @updated 2026-11-23T13:33:39+08:00
 */
import { useId, useState } from 'react';
import { Check, ChevronDown, Circle, CircleDot, ListChecks } from 'lucide-react';
import type { Step } from '@shared/types';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';

const statuses = {
  pending: { icon: Circle, labelKey: 'plan.pending' },
  in_progress: { icon: CircleDot, labelKey: 'plan.inProgress' },
  completed: { icon: Check, labelKey: 'plan.completed' },
} as const satisfies Record<Step['status'], { icon: typeof Circle; labelKey: string }>;

export function TaskPlan({
  steps,
  defaultOpen = false,
}: {
  steps: readonly Step[];
  defaultOpen?: boolean;
}) {
  const { t } = useUiTranslation('chat');
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const completed = steps.filter((step) => step.status === 'completed').length;
  const counts = { completed, count: steps.length };

  return (
    <div className="chat-task-plan">
      <Button
        className="chat-task-plan-toggle"
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={id}
        aria-label={t('progress.planSummary', counts)}
        onClick={() => setOpen((previous) => !previous)}
      >
        <ListChecks data-icon="inline-start" aria-hidden="true" />
        {t('plan.label')}
        <span className="chat-task-plan-count">{t('plan.count', counts)}</span>
        <ChevronDown className="chat-task-plan-chevron" data-icon="inline-end" aria-hidden="true" />
      </Button>
      <ul id={id} className="chat-task-plan-list" role="list" hidden={!open}>
        {open
          ? steps.map((step, index) => {
              const { icon: Icon, labelKey } = statuses[step.status];
              return (
                <li key={index} data-status={step.status}>
                  <Icon aria-hidden="true" />
                  <span className="chat-task-plan-text">{step.content}</span>
                  <span className="sr-only"> {t(labelKey)}</span>
                </li>
              );
            })
          : null}
      </ul>
    </div>
  );
}
