/**
 * @file 管理 Git 起草、编辑和确认的界面状态。
 * @implementation 取消已关闭的生成请求，遇到过期暂存区时保留文字并要求重新核对。
 * @updated 2026-11-24T04:36:00+08:00
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { useUiTranslation } from '@/i18n';
import { useDraftGitCommit } from '@/use-query/git/use-draft-git-commit';
import { useSubmitGitCommit } from '@/use-query/git/use-submit-git-commit';
import { gitCommitMessage, type GitCommitDraft } from '@shared/git-workbench';

export function useGitCommitReview(
  projectId: string,
  treeId: string,
  onBusy: (busy: boolean) => void,
) {
  const { locale } = useUiTranslation('git');
  const preparation = useDraftGitCommit(projectId, treeId);
  const submission = useSubmitGitCommit(projectId, treeId);
  const pending = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<GitCommitDraft>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<unknown>();
  const [stale, setStale] = useState(false);
  const [suggestionFailed, setSuggestionFailed] = useState(false);
  const [receipt, setReceipt] = useState<string>();
  const message = gitCommitMessage.safeParse({ title, body });

  useEffect(() => () => pending.current?.abort(), []);

  async function prepare(generate: boolean) {
    if (pending.current || submitting.current) return;
    const request = new AbortController();
    pending.current = request;
    setError(undefined);
    setSuggestionFailed(false);
    try {
      const next = await preparation.mutateAsync({ locale, generate, signal: request.signal });
      if (request.signal.aborted) return;
      setDraft(next);
      setStale(false);
      if (next.suggestion) {
        setTitle(next.suggestion.title);
        setBody(next.suggestion.body);
      }
      setSuggestionFailed(generate && !next.suggestion);
    } catch (cause) {
      if (!request.signal.aborted) setError(cause);
    } finally {
      if (pending.current === request) pending.current = null;
    }
  }

  function start() {
    setOpen(true);
    setDraft(undefined);
    setTitle('');
    setBody('');
    setStale(false);
    setReceipt(undefined);
    void prepare(true);
  }

  function close() {
    if (submitting.current) return;
    pending.current?.abort();
    pending.current = null;
    setOpen(false);
  }

  async function confirm() {
    if (!draft || stale || !message.success || pending.current || submitting.current) return;
    submitting.current = true;
    onBusy(true);
    setError(undefined);
    try {
      const result = await submission.mutateAsync({ ...message.data, version: draft.version });
      setReceipt(result.oid);
      setOpen(false);
    } catch (cause) {
      setError(cause);
      if (
        cause instanceof ApiError &&
        (cause.code === 'GIT_COMMIT_STALE' || cause.code === 'GIT_COMMIT_EMPTY')
      )
        setStale(true);
    } finally {
      submitting.current = false;
      onBusy(false);
    }
  }

  return {
    open,
    draft,
    title,
    body,
    error,
    stale,
    suggestionFailed,
    receipt,
    preparing: preparation.isPending,
    committing: submission.isPending,
    canConfirm: Boolean(
      draft && !stale && message.success && !preparation.isPending && !submission.isPending,
    ),
    setTitle,
    setBody,
    start,
    close,
    prepare,
    confirm,
  };
}
