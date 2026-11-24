/**
 * @file 展示 AI 提交核对表单。
 * @implementation 并排显示暂存清单和可编辑说明，提交失败时保留用户输入。
 * @updated 2026-11-24T04:36:00+08:00
 */
import { useId } from 'react';
import { GitBranch, GitCommitHorizontal, LoaderCircle, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { translateError, useUiTranslation } from '@/i18n';
import { GitFileLabel } from './git-file-label';
import type { useGitCommitReview } from './hooks/use-git-commit-review';

export function GitCommitDialog({
  review,
  restoreFocus,
}: {
  review: ReturnType<typeof useGitCommitReview>;
  restoreFocus: () => void;
}) {
  const { t, locale } = useUiTranslation('git');
  const { t: diff } = useUiTranslation('inspector');
  const fields = useId();
  const count = new Intl.NumberFormat(locale);
  const draft = review.draft;
  return (
    <Dialog
      open={review.open}
      onOpenChange={(open) => {
        if (!open) review.close();
      }}
    >
      <DialogContent
        className="git-commit-dialog"
        showCloseButton={!review.committing}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="git-board-title">
            <GitCommitHorizontal aria-hidden="true" />
            {t('commit.review')}
          </DialogTitle>
          <DialogDescription>{t('commit.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="git-commit-form"
          onSubmit={(event) => {
            event.preventDefault();
            void review.confirm();
          }}
        >
          {review.error ? (
            <p role="alert" className="git-commit-error">
              {translateError(review.error, t('errors.failed'))}
            </p>
          ) : null}
          {review.preparing ? (
            <p className="git-commit-status" role="status">
              <LoaderCircle aria-hidden="true" />
              {t(review.stale ? 'commit.reading' : 'commit.generating')}
            </p>
          ) : null}
          {review.suggestionFailed ? (
            <div className="git-commit-status" role="status">
              <span>{t('commit.noSuggestion')}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void review.prepare(true)}
              >
                <Sparkles data-icon="inline-start" aria-hidden="true" />
                {t('commit.retrySuggestion')}
              </Button>
            </div>
          ) : null}
          {draft ? (
            <div className="git-commit-columns">
              <section aria-labelledby={fields + '-staged'} className="git-commit-inventory">
                <header>
                  <div className="git-commit-branch" title={draft.branch ?? undefined}>
                    <GitBranch aria-hidden="true" />
                    <span className="truncate">{draft.branch ?? t('worktree.detached')}</span>
                  </div>
                  <div className="git-commit-inventory-count">
                    <h3 id={fields + '-staged'}>
                      {t('commit.stagedCount', { count: draft.fileCount })}
                    </h3>
                    <span className="git-patch-stats">
                      <span aria-label={diff('diff.addedLines', { count: draft.added })}>
                        +{count.format(draft.added)}
                      </span>
                      <span aria-label={diff('diff.removedLines', { count: draft.removed })}>
                        −{count.format(draft.removed)}
                      </span>
                    </span>
                  </div>
                </header>
                <ul className="git-commit-inventory-list">
                  {draft.files.map((file) => (
                    <li
                      key={file.path}
                      title={file.previousPath ? file.previousPath + ' → ' + file.path : file.path}
                    >
                      <GitFileLabel path={file.path} />
                      {file.added === null || file.removed === null ? (
                        <Badge variant="outline">{t('commit.binaryFile')}</Badge>
                      ) : (
                        <span className="git-patch-stats">
                          <span>+{count.format(file.added)}</span>
                          <span>−{count.format(file.removed)}</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {draft.fileCount > draft.files.length ? (
                  <p className="git-commit-omitted">
                    {t('commit.moreFiles', { count: draft.fileCount - draft.files.length })}
                  </p>
                ) : null}
              </section>
              <div className="git-commit-editor">
                <div className="git-field">
                  <label htmlFor={fields + '-title'}>{t('commit.title')}</label>
                  <input
                    id={fields + '-title'}
                    maxLength={240}
                    value={review.title}
                    disabled={review.committing || review.preparing}
                    onChange={(event) => review.setTitle(event.target.value)}
                    placeholder={t('commit.titlePlaceholder')}
                    required
                  />
                </div>
                <div className="git-field">
                  <label htmlFor={fields + '-body'}>{t('commit.body')}</label>
                  <textarea
                    id={fields + '-body'}
                    maxLength={8000}
                    rows={6}
                    value={review.body}
                    disabled={review.committing || review.preparing}
                    onChange={(event) => review.setBody(event.target.value)}
                    placeholder={t('commit.bodyPlaceholder')}
                  />
                </div>
                {draft.partial ? <p className="git-commit-omitted">{t('commit.partial')}</p> : null}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={review.committing}
              onClick={review.close}
            >
              {t('commit.cancel')}
            </Button>
            {review.stale || (!draft && !review.preparing) ? (
              <Button
                type="button"
                variant="secondary"
                disabled={review.preparing}
                onClick={() => void review.prepare(!draft)}
              >
                {t(draft ? 'commit.readAgain' : 'board.retry')}
              </Button>
            ) : null}
            <Button type="submit" disabled={!review.canConfirm}>
              <GitCommitHorizontal data-icon="inline-start" aria-hidden="true" />
              {t(review.committing ? 'commit.committing' : 'commit.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
