/**
 * @file 在运行轨迹中展示模型请求与 SDK 流的计时。
 * @implementation 分页展示请求和流的独立时间边界，解释未观测到的起点及中断的流。
 * @updated 2026-11-27T02:58:23+08:00
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import { formatDate, formatDuration } from '@/utils/format';
import type { RunRequestTiming } from '@shared/request-timing';

const pageSize = 20;

export function RequestTimings({ timing }: { timing: RunRequestTiming }) {
  const { t, locale } = useUiTranslation('inspector');
  const [offset, setOffset] = useState(0);
  const { records, omitted } = timing;
  const duration = (value: number | undefined) => formatDuration(value, locale);
  return (
    <section aria-labelledby="inspector-request-timing-heading">
      <h3 id="inspector-request-timing-heading" className="text-sm font-semibold">
        {t('trace.requestTiming')}
      </h3>
      <p className="mb-3 mt-1 text-xs leading-5 text-muted-foreground">
        {t(
          records.some(({ request }) => request)
            ? 'trace.requestTimingHint'
            : 'trace.requestTimingObservedOnly',
        )}
      </p>
      <ol start={offset + 1} className="divide-y divide-border rounded-xl border border-border">
        {records.slice(offset, offset + pageSize).map(({ request, stream }, index) => {
          const observedAt = request?.startedAt ?? stream?.firstEventAt;
          const firstToken = request?.ttftMs ?? stream?.ttftMs;
          const afterTool =
            stream?.lastToolFinishedAt === undefined
              ? undefined
              : stream.firstEventAt - stream.lastToolFinishedAt;
          const facts: [string, string][] = [];
          if (request) facts.push([t('trace.requestTotal'), duration(request.durationMs)]);
          if (firstToken !== undefined)
            facts.push([t('trace.requestFirstToken'), duration(firstToken)]);
          if (request?.firstContentMs !== undefined)
            facts.push([t('trace.requestFirstContent'), duration(request.firstContentMs)]);
          if (stream?.firstContentAfterEventMs !== undefined)
            facts.push([
              t('trace.requestStreamContent'),
              duration(stream.firstContentAfterEventMs),
            ]);
          if (stream?.outcome === 'complete')
            facts.push([t('trace.requestStream'), duration(stream.durationMs)]);
          const requestToStream = request && stream && stream.firstEventAt - request.startedAt;
          const toolToRequest =
            request && stream?.lastToolFinishedAt !== undefined
              ? request.startedAt - stream.lastToolFinishedAt
              : undefined;
          if (requestToStream !== undefined && requestToStream >= 0)
            facts.push([t('trace.requestToStream'), duration(requestToStream)]);
          if (toolToRequest !== undefined && toolToRequest >= 0)
            facts.push([t('trace.requestAfterToolStart'), duration(toolToRequest)]);
          else if (afterTool !== undefined && afterTool >= 0)
            facts.push([t('trace.requestAfterTool'), duration(afterTool)]);
          return (
            <li key={offset + index} className="flex flex-col gap-2 px-4 py-3">
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {observedAt !== undefined && (
                  <time dateTime={new Date(observedAt).toISOString()}>
                    {formatDate(new Date(observedAt).toISOString(), locale)}
                  </time>
                )}
                {stream?.scope === 'subagent' && <span>{t('trace.subtask')}</span>}
                {stream && !request && <span>{t('trace.requestNoSpan')}</span>}
                {request && !stream && <span>{t('trace.requestNoStream')}</span>}
                {stream?.outcome === 'interrupted' && (
                  <span>
                    {t('trace.requestNoStreamEnd', { duration: duration(stream.durationMs) })}
                  </span>
                )}
                {request?.attempts !== undefined && request.attempts > 1 && (
                  <span>{t('trace.requestAttempts', { count: request.attempts })}</span>
                )}
                {request?.failed && <span>{t('trace.requestFailed')}</span>}
              </p>
              {facts.length > 0 && (
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {facts.map(([label, value]) => (
                    <div key={label} className="flex gap-1">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ol>
      {omitted > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('trace.requestTimingOmitted', { count: omitted })}
        </p>
      )}
      {records.length > pageSize && (
        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(offset - pageSize)}
          >
            {t('common.previous')}
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + pageSize, records.length)} / {records.length}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={offset + pageSize >= records.length}
            onClick={() => setOffset(offset + pageSize)}
          >
            {t('common.next')}
          </Button>
        </div>
      )}
    </section>
  );
}
