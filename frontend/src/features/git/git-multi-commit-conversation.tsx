/**
 * @file 展示 AI 提交摘要及对话修改。
 * @implementation 汇总实际草稿变动并提供再次修改、撤销及确认入口。
 * @updated 2026-11-25T01:11:00+08:00
 */
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import type { useGitMultiCommitReview } from './hooks/use-git-multi-commit-review';
import { Textarea } from '@/components/ui/textarea';

export function GitMultiCommitConversation({
  review,
  busy,
  hidden,
  onDetails,
}: {
  review: ReturnType<typeof useGitMultiCommitReview>;
  busy: boolean;
  hidden: boolean;
  onDetails: () => void;
}) {
  const { t } = useUiTranslation('git');
  const [message, setMessage] = useState('');
  const field = useId();
  const units = review.draft?.units ?? [];
  const pathById = new Map(units.map(({ id, path }) => [id, path]));
  const assigned = new Set(review.groups.flatMap((group) => group.unitIds));
  const retained = new Set(review.excludedUnitIds);
  const pending = units.filter(({ id }) => !assigned.has(id) && !retained.has(id));
  const pathsOf = (ids: readonly string[]) => [
    ...new Set(ids.flatMap((id) => pathById.get(id) ?? [])),
  ];
  return (
    <section className="git-commit-conversation" hidden={hidden}>
      <div className="git-commit-conversation-scroll">
        <ol className="git-commit-conversation-groups">
          {review.groups.map((group, index) => {
            const paths = pathsOf(group.unitIds);
            return (
              <li key={group.id}>
                <strong>
                  {t('multi.groupLabel', {
                    number: index + 1,
                    title: group.title || t('commit.titlePlaceholder'),
                  })}
                </strong>
                <span>{t('multi.unitCount', { count: group.unitIds.length })}</span>
                {paths.length ? (
                  <p>
                    <code>{paths.slice(0, 3).join(', ')}</code>
                    {paths.length > 3
                      ? ` · ${t('multi.conversation.morePaths', { count: paths.length - 3 })}`
                      : null}
                  </p>
                ) : null}
                {group.body ? (
                  <details>
                    <summary>{t('commit.body')}</summary>
                    <p>{group.body}</p>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
        <p className="git-multi-commit-hint">
          {t('multi.conversation.summary', { pending: pending.length, retained: retained.size })}
        </p>
        {pending.length ? (
          <details>
            <summary>{t('multi.conversation.pending')}</summary>
            <p>
              <code>{pathsOf(pending.map(({ id }) => id)).join(', ')}</code>
            </p>
          </details>
        ) : null}
        {retained.size ? (
          <details>
            <summary>{t('multi.conversation.retained')}</summary>
            <p>
              <code>{pathsOf(review.excludedUnitIds).join(', ')}</code>
            </p>
          </details>
        ) : null}
        <ol className="git-commit-conversation-turns" aria-label={t('multi.conversation.history')}>
          {review.turns.map(({ id, instruction, note, before, after }) => {
            const prior = new Map(before.groups.map((group) => [group.id, group]));
            const afterIds = new Set(after.groups.map((group) => group.id));
            const beforeOrder = before.groups.filter(({ id }) => afterIds.has(id));
            const afterOrder = after.groups.filter(({ id }) => prior.has(id));
            const positions = new Map(beforeOrder.map(({ id }, index) => [id, index]));
            const moved = new Set(
              afterOrder.filter(({ id }, index) => positions.get(id) !== index).map(({ id }) => id),
            );
            const changed = after.groups.filter(
              (group) =>
                moved.has(group.id) ||
                JSON.stringify(group) !== JSON.stringify(prior.get(group.id)),
            );
            const removed = before.groups.filter(({ id }) => !afterIds.has(id));
            return (
              <li key={id}>
                <p>{instruction}</p>
                {before === after ? (
                  <p>{note || t('multi.conversation.noChange')}</p>
                ) : (
                  <>
                    <p>
                      {t('multi.conversation.applied', {
                        groups: changed.length,
                        removed: removed.length,
                        kept: after.excludedUnitIds.length - before.excludedUnitIds.length,
                      })}
                    </p>
                    {changed.length ? (
                      <p className="git-multi-commit-hint">
                        {changed
                          .map(({ title }) => title)
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <form
        className="git-commit-conversation-input"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !message.trim()) return;
          void review.revise(message).then((success) => {
            if (success) setMessage('');
          });
        }}
      >
        <label htmlFor={field}>{t('multi.conversation.input')}</label>
        <Textarea
          id={field}
          rows={2}
          maxLength={2000}
          value={message}
          placeholder={t('multi.conversation.placeholder')}
          disabled={busy || !review.canRevise}
          onChange={(event) => setMessage(event.target.value)}
        />
        {review.preparing === 'revision' || review.committing ? (
          <p className="git-multi-commit-hint" role="status">
            {t(review.committing ? 'multi.submitting' : 'multi.conversation.working')}
          </p>
        ) : review.canConfirmSummary ? (
          <p className="git-multi-commit-hint">{t('multi.localCommitNotice')}</p>
        ) : null}
        <div className="git-commit-conversation-actions">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onDetails}>
            {t('multi.conversation.details')}
          </Button>
          {review.canUndo ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={review.undoRevision}
            >
              {t('multi.conversation.undo')}
            </Button>
          ) : null}
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={busy || !review.canRevise || !message.trim()}
          >
            {t('multi.conversation.send')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !review.canConfirmSummary}
            onClick={() => void review.confirmSummary()}
          >
            {t('multi.confirm')}
          </Button>
        </div>
      </form>
    </section>
  );
}
