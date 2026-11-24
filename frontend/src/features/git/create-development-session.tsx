/**
 * @file 预览并提交创建开发会话的选择。
 * @implementation 保留输入和持久编号，确认后将预览基线提交给运行时。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { translateError, useUiTranslation } from '@/i18n';
import { usePreviewDevelopmentSession } from '@/use-query/git/use-preview-development-session';
import { useCreateDevelopmentSession } from '@/use-query/git/use-create-development-session';
import {
  developmentPreview,
  type DevelopmentPreview,
  type GitBranch,
  type GitCheckoutMode,
} from '@shared/git-workbench';

export function CreateDevelopmentSession({
  projectId,
  branches,
  sourceWorktreeId,
  onBack,
  onCreated,
  onBusy,
}: {
  projectId: string;
  branches: GitBranch[];
  sourceWorktreeId?: string;
  onBack: () => void;
  onCreated: (id: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useUiTranslation('git');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('head');
  const [commit, setCommit] = useState('');
  const [mode, setMode] = useState<GitCheckoutMode>('linked');
  const [validation, setValidation] = useState<'branch' | 'base'>();
  const preview = usePreviewDevelopmentSession(projectId);
  const create = useCreateDevelopmentSession(projectId);
  const review = preview.data;
  const busy = preview.isPending || create.isPending;

  function showPreview() {
    const input = developmentPreview.safeParse({
      requestId: crypto.randomUUID(),
      ...(sourceWorktreeId ? { sourceWorktreeId } : {}),
      branch: branch.trim(),
      mode,
      base:
        base === 'head'
          ? { kind: 'head' }
          : base === 'commit'
            ? { kind: 'commit', oid: commit.trim() }
            : { kind: 'branch', name: base.slice('branch:'.length) },
    });
    if (!input.success) {
      setValidation(
        input.error.issues.some((issue) => issue.path[0] === 'branch') ? 'branch' : 'base',
      );
      return;
    }
    setValidation(undefined);
    preview.mutate(input.data);
  }

  function editPreview() {
    preview.reset();
    create.reset();
  }

  async function confirm(input: DevelopmentPreview, expectedOid: string) {
    onBusy(true);
    try {
      const { session } = await create.mutateAsync({ ...input, expectedOid });
      onCreated(session.id);
    } catch {
      // The mutation retains the error and request ID for a retry.
    } finally {
      onBusy(false);
    }
  }

  const error = create.error ?? preview.error;
  return (
    <form
      className="git-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        if (review && preview.variables) void confirm(preview.variables, review.oid);
        else showPreview();
      }}
    >
      {review ? (
        <>
          <h3>{t('create.review')}</h3>
          <dl className="git-review">
            <dt>{t('create.branch')}</dt>
            <dd>{review.branch}</dd>
            <dt>{t('create.oid')}</dt>
            <dd>
              <code>{review.oid}</code>
            </dd>
            <dt>{t('create.destination')}</dt>
            <dd>{review.path}</dd>
          </dl>
          <p className="git-hint">
            {t(mode === 'linked' ? 'create.linkedDetail' : 'create.inPlaceDetail')}
          </p>
        </>
      ) : (
        <>
          <label className="git-field">
            {t('create.branch')}
            <input
              className="field"
              required
              maxLength={240}
              autoFocus
              spellCheck={false}
              value={branch}
              disabled={busy}
              onChange={(event) => setBranch(event.target.value)}
            />
          </label>
          <div className="git-field">
            <label htmlFor="git-start-point">{t('create.base')}</label>
            <Select value={base} onValueChange={setBase} disabled={busy}>
              <SelectTrigger id="git-start-point">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="head">{t('create.head')}</SelectItem>
                {branches
                  .filter(({ kind }) => kind === 'local')
                  .map(({ name }) => (
                    <SelectItem key={name} value={'branch:' + name}>
                      {name}
                    </SelectItem>
                  ))}
                <SelectItem value="commit">{t('create.commit')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {base === 'commit' && (
            <label className="git-field">
              {t('create.oid')}
              <input
                className="field"
                value={commit}
                required
                maxLength={64}
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setCommit(event.target.value)}
              />
            </label>
          )}
          <fieldset className="git-checkout-choices" disabled={busy}>
            <legend>{t('create.mode')}</legend>
            <label>
              <input
                type="radio"
                name="git-checkout-mode"
                checked={mode === 'linked'}
                onChange={() => setMode('linked')}
              />
              <span>{t('create.linked')}</span>
            </label>
            <label>
              <input
                type="radio"
                name="git-checkout-mode"
                checked={mode === 'in_place'}
                onChange={() => setMode('in_place')}
              />
              <span>{t('create.inPlace')}</span>
            </label>
            <p className="git-hint">
              {t(mode === 'linked' ? 'create.linkedDetail' : 'create.inPlaceDetail')}
            </p>
          </fieldset>
        </>
      )}
      {error || validation ? (
        <p role="alert" className="text-destructive">
          {validation
            ? t(validation === 'branch' ? 'errors.invalidBranch' : 'errors.baseMissing')
            : translateError(error, t('errors.failed'))}
        </p>
      ) : null}
      <div className="dialog-actions">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={review ? editPreview : onBack}
        >
          <ArrowLeft data-icon="inline-start" aria-hidden="true" />
          {t(review ? 'create.edit' : 'board.back')}
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {t(
            review
              ? busy
                ? 'create.creating'
                : 'create.confirm'
              : busy
                ? 'create.previewing'
                : 'create.preview',
          )}
        </Button>
      </div>
    </form>
  );
}
