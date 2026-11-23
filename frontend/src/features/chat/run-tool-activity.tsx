/**
 * @file 在助手消息里展示本轮主助手执行的操作。
 * @implementation 默认展开运行中的明细，保留当前阅读位置，并按需显示较早的调用与完整输出。
 * @updated 2026-11-22T18:35:00+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ToolCall } from '@shared/types';
import { Button } from '@/components/ui/button';
import { ToolDetail } from '@/features/inspector/tool-detail';
import { toolDisplayStatus, toolOutputView } from '@/features/inspector/tool-detail-format';

export function RunToolActivity({
  tools,
  active,
  approved,
  onOutput,
}: {
  tools: ToolCall[];
  active: boolean;
  approved: ReadonlySet<string>;
  onOutput: (tool: ToolCall) => void;
}) {
  const { t } = useUiTranslation('chat');
  const id = useId();
  const [expanded, setExpanded] = useState<boolean>();
  const [from, setFrom] = useState<number>();
  const open = expanded ?? active;
  const failedCount = tools.filter(
    (tool) => toolDisplayStatus(tool, toolOutputView(tool)) === 'failed',
  ).length;
  const latest = Math.max(0, tools.length - 4);
  const start = Math.min(from ?? latest, latest);
  const visible = open
    ? tools.filter(
        (tool, i) =>
          i >= start || tool.status === 'running' || tool.status === 'awaiting_permission',
      )
    : [];
  return (
    <div className="run-tool-activity">
      <Button
        className="run-activity-toggle"
        type="button"
        variant="ghost"
        size="xs"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setExpanded(!open)}
      >
        <ChevronRight data-icon="inline-start" aria-hidden="true" />
        {t('activity.details', { count: tools.length })}
        {failedCount > 0 ? (
          <span className="run-activity-failed">
            {t('activity.failedCount', { count: failedCount })}
          </span>
        ) : null}
      </Button>
      <div id={id} hidden={!open}>
        {open ? (
          <>
            {visible.length < tools.length ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={() => {
                  setExpanded(true);
                  setFrom(Math.max(0, start - 12));
                }}
              >
                {t('activity.earlier')}
              </Button>
            ) : null}
            <div
              className="run-tool-list"
              onFocusCapture={(event) => {
                // Keep the reader's row mounted across new calls and the terminal run update.
                setExpanded(true);
                const selected =
                  event.target.closest<HTMLElement>('[data-tool-id]')?.dataset.toolId;
                const index = tools.findIndex((item) => item.id === selected);
                setFrom(index < 0 ? start : Math.min(start, index));
              }}
            >
              {visible.map((tool) => (
                <ToolDetail
                  key={tool.id}
                  tool={tool}
                  variant="compact"
                  automaticallyApproved={approved.has(tool.id)}
                  onOutput={() => onOutput(tool)}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
