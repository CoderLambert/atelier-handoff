/**
 * @file 展示旧格式运行的单条消息。
 * @implementation 保留占位和末条助手的进度、审批及运行结果归属，按实际使用的切片比较历史消息。
 * @updated 2026-11-27T19:30:00+08:00
 */
import { memo } from 'react';
import { cn } from '@/components/ui/utils';
import { useUiTranslation } from '@/i18n';
import {
  ChatApproval,
  MessageFooter,
  RunEndExtras,
  UserMessageBubble,
} from './conversation-turn-parts';
import { areLegacyTurnPropsEqual, isActive, type LegacyTurnProps } from './conversation-turns';
import { Markdown } from './markdown';
import { RunProgress } from './run-progress';

export const LegacyMessageTurn = memo(function LegacyMessageTurn(props: LegacyTurnProps) {
  const { t } = useUiTranslation('chat');
  const { turn, sessionId, hasFork, stopPending, isComposerPlanOwner, actions } = props;
  const { message, slice, isFooterOwner, isLastMessage, hasSubsequent } = turn;
  const { run, tools, events, permissions, subagents, attachments, contextRestarted } = slice;
  const { onTrace, onPermission, onOutput, onLinkClick } = actions;
  const assistant = message.role === 'assistant';
  const hasText = Boolean(message.text.trim());
  const active = run ? isActive(run) : false;
  const ownsRunFooter = assistant && isFooterOwner;
  const footerRun = ownsRunFooter ? run : undefined;
  const childToolIds = new Set(
    ownsRunFooter
      ? tools
          .filter((tool) => tool.sessionId === sessionId && tool.subagentId)
          .map((tool) => tool.id)
      : [],
  );
  return (
    <article
      className={cn('message', assistant ? 'assistant-message' : 'user-message')}
      aria-label={t(assistant ? 'conversation.assistant' : 'conversation.you')}
      data-message-id={message.id}
      data-run-id={message.runId}
      data-last-message={isLastMessage || undefined}
    >
      <div className="message-body">
        {footerRun ? (
          <RunProgress
            run={footerRun}
            stopPending={stopPending && active}
            tools={tools}
            events={events}
            hasText={hasText}
            sessionId={sessionId}
            permissions={permissions}
            subagents={subagents}
            showPlan={!isComposerPlanOwner && footerRun.plan.length > 0}
            onPermission={onPermission}
            onOutput={onOutput}
            onTrace={() => onTrace(footerRun.id)}
          />
        ) : null}
        {ownsRunFooter
          ? permissions
              .filter(
                (item) =>
                  item.decisionSource !== 'automatic' &&
                  (item.sessionId !== sessionId ||
                    (!item.subagentId && !childToolIds.has(item.toolCallId))),
              )
              .map((item) => (
                <ChatApproval key={item.id} permission={item} onPermission={onPermission} />
              ))
          : null}
        {assistant ? (
          hasText ? (
            <Markdown text={message.text} streaming={active} onLinkClick={onLinkClick} />
          ) : active ? null : (
            <p className="message-placeholder">{t('conversation.noReply')}</p>
          )
        ) : (
          <UserMessageBubble
            text={message.text}
            run={run}
            attachments={attachments}
            contextRestarted={hasFork && contextRestarted}
          />
        )}
        <MessageFooter
          message={message}
          at={message.createdAt}
          hasSubsequent={hasSubsequent}
          legacyHasText={hasText}
          state={props}
        />
        {footerRun ? (
          <RunEndExtras slice={{ ...slice, run: footerRun }} state={props} hasText={hasText} />
        ) : null}
      </div>
    </article>
  );
}, areLegacyTurnPropsEqual);
