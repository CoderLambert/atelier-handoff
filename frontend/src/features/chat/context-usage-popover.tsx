/**
 * @file 展示当前会话的上下文窗口和最近请求缓存。
 * @implementation 按 SDK 分类呈现估算窗口，并将缓存命中率与累计用量区分。
 * @updated 2026-11-23T03:40:00+08:00
 */
import { ChevronRight, Gauge } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';
import { cacheHitRatio, contextStats, type ContextUsage } from '@shared/context-usage';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useUiTranslation } from '@/i18n';

const categoryEntries = [
  ['system_prompt', 'window.systemPrompt'],
  ['system_tools', 'window.systemTools'],
  ['mcp_tools', 'window.mcpTools'],
  ['mcp_instructions', 'window.mcpInstructions'],
  ['mcp_tools_deferred', 'window.mcpTools'],
  ['system_tools_deferred', 'window.systemTools'],
  ['custom_agents', 'window.agents'],
  ['memory_files', 'window.memory'],
  ['skills', 'window.skills'],
  ['messages', 'window.messages'],
] as const;
const categoryLabels = new Map<string, (typeof categoryEntries)[number][1]>(categoryEntries);

const messageLabels = [
  ['userMessageTokens', 'window.userMessages'],
  ['assistantMessageTokens', 'window.assistantMessages'],
  ['toolCallTokens', 'window.toolCalls'],
  ['toolResultTokens', 'window.toolResults'],
  ['attachmentTokens', 'window.attachments'],
  ['redirectedContextTokens', 'window.redirectedContext'],
  ['unattributedTokens', 'window.otherMessages'],
] as const;

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2 py-0.5">
      <dt className="truncate text-muted-foreground" title={label}>
        {label}
      </dt>
      <dd className="text-right font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function UsageDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          data-icon="inline-start"
          className="size-3.5 shrink-0 group-open:rotate-90"
          aria-hidden="true"
        />
        <span className="min-w-0 break-words">{label}</span>
      </summary>
      {children}
    </details>
  );
}

export function ContextUsagePopover({
  sample,
  running,
  hasRuns,
}: {
  sample?: { context: ContextUsage; previous: boolean };
  running: boolean;
  hasRuns: boolean;
}) {
  const { t, locale } = useUiTranslation('chat');
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const context = sample?.context;
  const stats = context ? contextStats(context) : undefined;
  const remaining = stats?.remainingRatio;
  const level =
    remaining === undefined
      ? 'empty'
      : remaining < 0.15
        ? 'danger'
        : remaining < 0.3
          ? 'warning'
          : 'normal';
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const remainingLabel =
    remaining === undefined
      ? undefined
      : t('window.triggerRemaining', { percent: percent.format(remaining) });
  const triggerTitle = t(sample?.previous ? 'window.staleTitle' : 'window.title');
  const emptyMessage = running
    ? 'window.waiting'
    : hasRuns
      ? 'window.noMeasurement'
      : 'window.noSample';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={remaining === undefined ? 'icon-xs' : 'xs'}
          className="context-usage-trigger"
          data-level={level}
          data-stale={sample?.previous || undefined}
          aria-label={t('window.title')}
          aria-description={
            sample?.previous && remainingLabel
              ? `${remainingLabel} · ${triggerTitle}`
              : remainingLabel
          }
          title={remainingLabel ? `${triggerTitle} · ${remainingLabel}` : triggerTitle}
        >
          <Gauge aria-hidden="true" data-icon="inline-start" />
          {remaining !== undefined ? (
            <span className="tabular-nums" aria-hidden="true">
              {percent.format(remaining)}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-labelledby={headingId}
        className="flex w-[min(23rem,calc(100vw_-_24px))] flex-col gap-2.5 text-sm leading-snug [&_dd]:m-0 [&_dl]:m-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          heading.current?.focus({ preventScroll: true });
        }}
      >
        <h2
          id={headingId}
          ref={heading}
          tabIndex={-1}
          className="m-0 text-sm font-semibold outline-none"
        >
          {t('window.title')}
        </h2>
        {sample && stats ? (
          <ContextUsageDetails context={sample.context} stats={stats} previous={sample.previous} />
        ) : (
          <p className="text-muted-foreground" role="status">
            {t(emptyMessage)}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ContextUsageDetails({
  context,
  stats,
  previous,
}: {
  context: ContextUsage;
  stats: ReturnType<typeof contextStats>;
  previous: boolean;
}) {
  const { t, locale } = useUiTranslation('chat');
  const numbers = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const time = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
  const tokens = (value: number | null | undefined) =>
    value == null ? t('window.unavailable') : numbers.format(value);
  const usage = context.requestUsage;
  const hit = cacheHitRatio(usage);
  const used = context.categories
    .filter((row) => row.kind === 'used' && row.tokens > 0)
    .toSorted((left, right) => right.tokens - left.tokens);
  const deferred = context.categories.filter((row) => row.kind === 'deferred' && row.tokens > 0);
  const rows = (categories: typeof used) =>
    categories.map((row, index) => {
      const label = row.id && categoryLabels.get(row.id);
      return (
        <Metric key={`${row.id ?? row.name}:${index}`} label={label ? t(label) : row.name}>
          {tokens(row.tokens)}
        </Metric>
      );
    });
  const breakdown = messageLabels.flatMap(([key, label]) => {
    const value = context.messageBreakdown?.[key];
    return value
      ? [
          <Metric key={key} label={t(label)}>
            {tokens(value)}
          </Metric>,
        ]
      : [];
  });
  return (
    <>
      <dl className="grid grid-cols-2 divide-x divide-border rounded-lg border border-border bg-muted/50">
        <div className="min-w-0 px-3 py-2.5">
          <dt className="text-xs text-muted-foreground">{t('window.availableLabel')}</dt>
          <dd className="text-xl leading-tight font-semibold tabular-nums">
            {percent.format(stats.remainingRatio)}
          </dd>
          <dd className="text-xs text-muted-foreground tabular-nums">
            {t('window.tokenAmount', { tokens: tokens(stats.remainingTokens) })}
          </dd>
        </div>
        <div className="min-w-0 px-3 py-2.5">
          <dt className="text-xs text-muted-foreground">{t('window.cacheHit')}</dt>
          <dd className="text-xl leading-tight font-semibold tabular-nums">
            {hit === null ? t('window.unavailable') : percent.format(hit)}
          </dd>
          <dd className="text-xs text-muted-foreground">{t('window.latestRequest')}</dd>
        </div>
      </dl>
      <dl className="grid">
        <Metric label={t('window.effectiveWindow')}>
          {t('window.used', {
            used: tokens(context.usedTokens),
            max: tokens(context.windowTokens),
            percent: percent.format(stats.usedRatio),
          })}
        </Metric>
        {stats.reservedTokens > 0 && (
          <Metric label={t('window.reserve')}>{tokens(stats.reservedTokens)}</Metric>
        )}
      </dl>
      <section className="grid gap-1 border-t border-border pt-2.5">
        <h3 className="m-0 text-sm font-semibold">{t('window.composition')}</h3>
        {used.length ? (
          <dl>{rows(used)}</dl>
        ) : (
          <p className="m-0 text-muted-foreground">{t('window.unavailable')}</p>
        )}
        {breakdown.length > 0 && (
          <UsageDisclosure label={t('window.messageDetails')}>
            <div className="rounded-md bg-muted/50 px-3 py-1.5">
              <dl>{breakdown}</dl>
              <p className="m-0 mt-1 text-xs text-muted-foreground">
                {t('window.messageEstimate')}
              </p>
            </div>
          </UsageDisclosure>
        )}
        {deferred.length > 0 && (
          <UsageDisclosure label={t('window.deferred')}>
            <dl className="rounded-md bg-muted/50 px-3 py-1.5">{rows(deferred)}</dl>
          </UsageDisclosure>
        )}
      </section>
      {usage && (
        <section className="border-t border-border">
          <UsageDisclosure label={t('window.requestDetails')}>
            <dl className="rounded-md bg-muted/50 px-3 py-1.5">
              <Metric label={t('window.uncachedInput')}>{tokens(usage.inputTokens)}</Metric>
              <Metric label={t('window.cacheRead')}>{tokens(usage.cacheReadTokens)}</Metric>
              <Metric label={t('window.cacheWrite')}>{tokens(usage.cacheCreationTokens)}</Metric>
              <Metric label={t('window.output')}>{tokens(usage.outputTokens)}</Metric>
            </dl>
          </UsageDisclosure>
        </section>
      )}
      <div className="grid gap-1 border-t border-border pt-2.5 text-xs text-muted-foreground">
        <p className="m-0 truncate" title={context.model}>
          {t(previous ? 'window.previousSample' : 'window.sample', {
            model: context.model,
            time: time.format(new Date(context.capturedAt)),
          })}
        </p>
        <p className="m-0">{t('window.estimated')}</p>
      </div>
    </>
  );
}
