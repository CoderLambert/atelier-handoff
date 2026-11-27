/**
 * @file 渲染多提交计划底部操作栏与预检差异预览区。
 * @implementation 汇总阻塞原因、快速跳转到未分配或未分析视图，并提供预检和确认本地提交按钮。
 * @updated 2026-11-27T21:50:00+08:00
 */
import type { RefObject } from 'react';
import { GitCommitHorizontal, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import type {
  GitMultiCommitGroup,
  GitMultiCommitPreview,
  InventoryView,
} from './git-multi-commit-types';

export function GitMultiCommitPreviewPane({
  fieldsPrefix,
  previewHeadingRef,
  groups,
  preview,
}: {
  fieldsPrefix: string;
  previewHeadingRef: RefObject<HTMLHeadingElement | null>;
  groups: readonly GitMultiCommitGroup[];
  preview: GitMultiCommitPreview;
}) {
  const { t } = useUiTranslation('git');
  return (
    <section className="git-multi-commit-previews" aria-labelledby={fieldsPrefix + '-previews'}>
      <h4 id={fieldsPrefix + '-previews'} ref={previewHeadingRef} tabIndex={-1}>
        {t('multi.previewHeading')}
      </h4>
      <p className="git-multi-commit-hint">{t('multi.localCommitNotice')}</p>
      {groups.map((group, index) => (
        <section key={group.id} className="git-multi-commit-preview">
          <h5>{t('multi.groupLabel', { number: index + 1, title: group.title })}</h5>
          <div
            className="git-multi-commit-diff"
            role="region"
            tabIndex={0}
            aria-label={t('multi.groupLabel', { number: index + 1, title: group.title })}
          >
            {preview.renderGroupDiff(group, index)}
          </div>
        </section>
      ))}
    </section>
  );
}

export function GitMultiCommitFooter({
  fieldsPrefix,
  status,
  blockingReasons,
  pendingCount,
  unanalyzedCount,
  previewCurrent,
  previewDisabled,
  confirmDisabled,
  onJumpToInventory,
  onCancel,
  onPreview,
  onConfirm,
}: {
  fieldsPrefix: string;
  status: 'ready' | 'loading' | 'previewing' | 'submitting';
  blockingReasons: readonly string[];
  pendingCount: number;
  unanalyzedCount: number;
  previewCurrent: boolean;
  previewDisabled: boolean;
  confirmDisabled: boolean;
  onJumpToInventory: (target: Extract<InventoryView, 'pending' | 'unanalyzed'>) => void;
  onCancel?: () => void;
  onPreview: () => void;
  onConfirm: () => void;
}) {
  const { t } = useUiTranslation('git');
  return (
    <footer className="git-multi-commit-footer">
      {confirmDisabled && blockingReasons.length > 0 ? (
        <div
          id={fieldsPrefix + '-blocking'}
          className="git-multi-commit-blocking"
          role="status"
          aria-live="polite"
        >
          <strong>{previewDisabled ? t('multi.cannotPreview') : t('multi.cannotConfirm')}</strong>
          <ul>
            {blockingReasons.slice(0, 5).map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
            {blockingReasons.length > 5 ? <li>{t('multi.moreIssues')}</li> : null}
          </ul>
          {pendingCount || unanalyzedCount ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onJumpToInventory(pendingCount ? 'pending' : 'unanalyzed')}
            >
              {pendingCount ? t('multi.view.pending') : t('multi.view.unanalyzed')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {onCancel ? (
        <Button
          type="button"
          variant="outline"
          disabled={status === 'submitting'}
          onClick={onCancel}
        >
          {t('commit.cancel')}
        </Button>
      ) : null}
      <Button
        type="button"
        variant={previewCurrent ? 'outline' : 'default'}
        disabled={previewDisabled}
        aria-describedby={
          confirmDisabled && blockingReasons.length ? fieldsPrefix + '-blocking' : undefined
        }
        onClick={() => {
          if (!previewDisabled) onPreview();
        }}
      >
        {t('multi.preview')}
      </Button>
      <Button
        type="button"
        variant={previewCurrent ? 'default' : 'outline'}
        disabled={confirmDisabled}
        aria-describedby={
          confirmDisabled && blockingReasons.length ? fieldsPrefix + '-blocking' : undefined
        }
        onClick={() => {
          if (!confirmDisabled) onConfirm();
        }}
      >
        {status === 'submitting' ? (
          <LoaderCircle data-icon="inline-start" aria-hidden="true" />
        ) : (
          <GitCommitHorizontal data-icon="inline-start" aria-hidden="true" />
        )}
        {status === 'submitting' ? t('multi.submitting') : t('multi.confirm')}
      </Button>
    </footer>
  );
}
