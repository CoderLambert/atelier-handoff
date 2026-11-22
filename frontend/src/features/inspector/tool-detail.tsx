/**
 * @file 在会话消息、子任务和执行轨迹中展示工具调用详情。
 * @implementation 通过同一摘要及展开内容渲染命令、参数和已记录回执，按语义回调打开完整输出，支持紧凑聊天行。
 * @updated 2026-11-22T18:42:04+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ToolCall } from '@shared/types';
import { ChevronRight } from 'lucide-react';
import { StatusBadge, formatDate, formatDuration } from './shared';
import {
  splitCommandForDisplay,
  toolDisplayStatus,
  toolInputView,
  toolOutputMessage,
  toolOutputPresentation,
  toolOutputView,
} from './tool-detail-format';

export { toolCallSummary } from './tool-detail-format';

export interface ToolDetailProps {
  tool: ToolCall;
  automaticallyApproved: boolean;
  onOutput?: () => void;
  variant?: 'default' | 'compact';
}

function ToolText({
  label,
  text,
  preview = false,
  excerptLabel,
  showLabel = false,
  format,
}: {
  label: string;
  text: string;
  preview?: boolean;
  excerptLabel?: string;
  showLabel?: boolean;
  format?: 'shell';
}) {
  const { t } = useUiTranslation('inspector');
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const excerpt = preview ? text.split('\n', 81).join('\n').slice(0, 8000) : text;
  const long = excerpt.length < text.length;
  const content = text.length ? (long && !expanded ? `${excerpt}\n…` : text) : t('tool.empty');
  const commandLines = format === 'shell' ? splitCommandForDisplay(content) : undefined;
  return (
    <div className="tool-detail__text">
      <div className="tool-detail__code-panel">
        {showLabel ? <p className="tool-detail__code-label">{label}</p> : null}
        <pre id={id} aria-label={label} className="tool-detail__pre" tabIndex={0}>
          {commandLines && commandLines.length > 1
            ? commandLines.map((line, index) => (
                <span key={index} className="tool-detail__command-line">
                  {line}
                </span>
              ))
            : content}
        </pre>
      </div>
      {long ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {t('tool.toggleExcerpt', {
            action: expanded ? t('tool.collapse') : t('tool.expand'),
            label: excerptLabel ?? t('tool.recordedOutput'),
            characters: t('tool.characters', { count: text.length }),
          })}
        </Button>
      ) : null}
    </div>
  );
}

/** Expanded content for execution events that already own a disclosure. */
export function ToolDetailBody({
  tool,
  automaticallyApproved,
  onOutput,
  variant = 'default',
}: ToolDetailProps) {
  const { t } = useUiTranslation('inspector');
  const input = toolInputView(tool);
  const output = toolOutputView(tool);
  const message = toolOutputMessage(tool, output);
  const presentation = toolOutputPresentation(tool);
  const excerptLabel = tool.bashLog ? t('tool.sdkPreviewWithSpace') : t('tool.recordedOutput');
  const waiting =
    tool.status === 'running' ||
    tool.status === 'awaiting_permission' ||
    Boolean(output.backgroundTaskId && tool.status === 'succeeded');
  const longOutput = tool.output.length > 8000 || tool.output.split('\n', 82).length > 81;
  const showOutputAction = Boolean(
    onOutput && (tool.bashLog || tool.outputTruncated || longOutput),
  );
  return (
    <div className="tool-detail__body" data-variant={variant}>
      <p className="tool-detail__meta">
        <time dateTime={tool.startedAt}>{formatDate(tool.startedAt)}</time>
        <span>
          {formatDuration(
            tool.endedAt ? Date.parse(tool.endedAt) - Date.parse(tool.startedAt) : null,
          )}
        </span>
        {automaticallyApproved ? <span>{t('common.approvalAutomatic')}</span> : null}
        <span className="tool-detail__id">{tool.id}</span>
      </p>
      <section
        aria-label={t('tool.parameters')}
        className="tool-detail__section tool-detail__section--input"
      >
        {!input.command ? <h4 className="tool-detail__label">{t('tool.parameters')}</h4> : null}
        {input.command ? (
          <ToolText label={t('tool.command')} text={input.command} showLabel format="shell" />
        ) : input.isCommand ? (
          <p className="tool-detail__notice">{t('tool.commandNotRecorded')}</p>
        ) : null}
        {input.explanation ? (
          <div className="tool-detail__section">
            <p className="tool-detail__label">{t('tool.explanation')}</p>
            <p className="tool-detail__explanation">{input.explanation}</p>
          </div>
        ) : null}
        {input.rawInput && input.command ? (
          <details className="tool-detail__raw">
            <summary>{t('tool.rawParameters')}</summary>
            <p className="tool-detail__notice">{t('tool.invalidJson')}</p>
            <ToolText label={t('tool.parameters')} text={input.parameters} />
          </details>
        ) : (
          <>
            {input.rawInput ? <p className="tool-detail__notice">{t('tool.invalidJson')}</p> : null}
            {input.parameters.length ? (
              <ToolText
                label={t('tool.parameters')}
                text={input.parameters}
                showLabel={Boolean(input.command)}
              />
            ) : !input.command ? (
              <p className="tool-detail__notice">{t('tool.noParameters')}</p>
            ) : null}
          </>
        )}
      </section>
      <section aria-label={t('tool.output')} className="tool-detail__section">
        <h4 className="tool-detail__label">
          {tool.bashLog ? t('tool.sdkPreview') : t('tool.output')}
        </h4>
        {presentation.scope ? <p className="tool-detail__notice">{presentation.scope}</p> : null}
        {input.isCommand ? (
          <dl aria-label={t('tool.executionResult')} className="tool-detail__result">
            <div>
              <dt>{t('tool.exitCode')}</dt>
              <dd>{output.exitCode == null ? t('tool.notProvided') : output.exitCode}</dd>
            </div>
            {output.interrupted !== undefined ? (
              <div>
                <dt>{t('tool.interrupted')}</dt>
                <dd>{output.interrupted ? t('tool.yes') : t('tool.no')}</dd>
              </div>
            ) : null}
            {output.backgroundTaskId ? (
              <div>
                <dt>{t('tool.backgroundTask')}</dt>
                <dd>{output.backgroundTaskId}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {message ? (
          <p role={waiting ? 'status' : undefined} className="tool-detail__notice">
            {message}
          </p>
        ) : null}
        {output.sections
          .filter((section) => section.label !== t('tool.otherFields') && section.text.length > 0)
          .map((section) => (
            <ToolText
              key={section.label}
              label={section.label}
              text={section.text}
              preview
              excerptLabel={excerptLabel}
              showLabel
            />
          ))}
        {output.sections.some((section) => section.label === t('tool.otherFields')) ? (
          <details className="tool-detail__raw">
            <summary>{t('tool.rawReceipt')}</summary>
            <ToolText
              label={t('tool.rawReceipt')}
              text={tool.output}
              preview
              excerptLabel={excerptLabel}
            />
          </details>
        ) : null}
        {output.truncated ? (
          <p className="tool-detail__notice">
            {tool.bashLog
              ? t('tool.sdkTruncated')
              : tool.outputTruncated
                ? onOutput
                  ? t('tool.previewTruncated')
                  : t('tool.noFullOutput')
                : t('tool.runnerTruncated')}
          </p>
        ) : null}
        {showOutputAction ? (
          <div>
            <Button type="button" variant="outline" size="sm" onClick={onOutput}>
              {presentation.actionLabel}
              {!tool.bashLog && tool.outputLength != null
                ? ` · ${t('tool.characters', { count: tool.outputLength })}`
                : ''}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function ToolDetail({
  tool,
  automaticallyApproved,
  onOutput,
  variant = 'default',
}: ToolDetailProps) {
  const { t } = useUiTranslation('inspector');
  const input = toolInputView(tool);
  const status = toolDisplayStatus(tool, toolOutputView(tool));
  const description = variant === 'compact' ? input.explanation : undefined;
  return (
    <details className="tool-detail" data-tool-id={tool.id} data-variant={variant}>
      <summary className="tool-detail__summary">
        <ChevronRight aria-hidden="true" className="tool-detail__chevron" />
        <span className="tool-detail__identity">
          <span className="tool-detail__heading">
            <span className="tool-detail__name" title={input.name}>
              {input.name}
            </span>
            {description ? (
              <span className="tool-detail__description" title={description}>
                {description}
              </span>
            ) : null}
          </span>
          {input.target ? (
            <span
              className="tool-detail__target"
              data-command={input.isCommand || undefined}
              title={input.target}
            >
              {input.target}
            </span>
          ) : null}
        </span>
        {automaticallyApproved ? (
          <span className="tool-detail__approval">{t('common.approvalAutomatic')}</span>
        ) : null}
        <span className="tool-detail__status" data-status={status}>
          <StatusBadge status={status} />
        </span>
      </summary>
      <ToolDetailBody
        tool={tool}
        automaticallyApproved={false}
        onOutput={onOutput}
        variant={variant}
      />
    </details>
  );
}
