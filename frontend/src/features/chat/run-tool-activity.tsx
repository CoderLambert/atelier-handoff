/**
 * @file 在助手消息里展示本轮主助手执行的操作。
 * @implementation 运行中默认展开明细，历史明细随所在运行展开。按需显示更早调用和完整输出，并保留当前阅读位置。
 * @updated 2026-11-27T19:30:00+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ToolCall } from '@shared/types';
import { Button } from '@/components/ui/button';
import { ToolDetail } from '@/features/inspector/tool-detail';
import { toolDisplayStatus, toolOutputView } from '@/features/inspector/tool-detail-format';

const recentCallCount = 4;
const earlierCallPageSize = 12;

export function RunToolActivity({
  tools,
  active,
  liveHeading,
  historyOpen,
  approved,
  onOutput,
}: {
  tools: ToolCall[];
  active: boolean;
  liveHeading?: ReactNode;
  historyOpen: boolean;
  approved: ReadonlySet<string>;
  onOutput: (tool: ToolCall) => void;
}) {
  const { t } = useUiTranslation('chat');
  const id = useId();
  const [expanded, setExpanded] = useState<boolean>();
  const [from, setFrom] = useState<number>();
  const open = active ? (expanded ?? true) : historyOpen;
  const failedCount = tools.filter(
    (tool) => toolDisplayStatus(tool, toolOutputView(tool)) === 'failed',
  ).length;
  const latest = Math.max(0, tools.length - recentCallCount);
  const start = Math.min(from ?? latest, latest);
  const visible: ToolCall[] = [];
  const hiddenIndices: number[] = [];
  if (open) {
    tools.forEach((tool, index) => {
      if (index >= start || tool.status === 'running' || tool.status === 'awaiting_permission') {
        visible.push(tool);
      } else {
        hiddenIndices.push(index);
      }
    });
  }
  const nextCount = Math.min(hiddenIndices.length, earlierCallPageSize);
  const nextStart = hiddenIndices[hiddenIndices.length - nextCount];
  const failures =
    failedCount > 0 ? (
      <span className="run-activity-failed">
        {t('activity.failedCount', { count: failedCount })}
      </span>
    ) : null;
  return (
    <div className="run-tool-activity">
      {active ? (
        <div className="run-live-activity-bar">
          {liveHeading}
          <Button
            className="run-activity-toggle"
            data-preserve-scroll
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setExpanded(!open)}
          >
            <span className="sr-only">{t('activity.label')}</span>
            {t('activity.liveCount', {
              finished: tools.filter((tool) => tool.endedAt).length,
              total: tools.length,
            })}
            {failures}
            <ChevronRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <p className="run-history-section-label">
          <span>{t('activity.calls', { count: tools.length })}</span>
          {failures}
        </p>
      )}
      <div id={id} hidden={!open}>
        {open ? (
          <>
            {tools.length > recentCallCount ? (
              <div className="run-tool-pagination">
                <span role="status">
                  {t('activity.visibleCount', { shown: visible.length, total: tools.length })}
                </span>
                {nextStart === undefined ? null : (
                  <Button
                    type="button"
                    data-preserve-scroll
                    variant="link"
                    size="xs"
                    onClick={() => {
                      setExpanded(true);
                      setFrom(nextStart);
                    }}
                  >
                    {t('activity.showEarlier', { count: nextCount })}
                  </Button>
                )}
              </div>
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
