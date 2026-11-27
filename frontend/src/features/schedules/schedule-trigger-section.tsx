/**
 * @file 提供渐进披露的任务触发方式与远程遥控配置折叠区。
 * @implementation 默认折叠保持界面清爽；展开后展示会话调用别名、远程触发窄口路径、单任务令牌签发/轮换/吊销与一键复制 curl 示例。
 * @updated 2026-11-27T15:30:00+08:00
 */
import { useEffect, useState } from 'react';
import { Check, ChevronDown, Copy, KeyRound, Radio, RotateCw, ShieldOff } from 'lucide-react';
import type { ScheduledTask } from '@shared/types';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import { useIssueScheduleTriggerToken } from '@/use-query/schedules/use-issue-schedule-trigger-token';
import { useRevokeScheduleTriggerToken } from '@/use-query/schedules/use-revoke-schedule-trigger-token';
import {
  buildScheduleTriggerCurl,
  buildScheduleTriggerEndpointLabel,
} from './schedule-trigger-format';

export function ScheduleTriggerSection({ task }: { task: ScheduledTask }) {
  const { t } = useUiTranslation('schedules');
  const [open, setOpen] = useState(false);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const issueMutation = useIssueScheduleTriggerToken();
  const revokeMutation = useRevokeScheduleTriggerToken();

  useEffect(() => {
    setIssuedToken(null);
    setCopied(false);
  }, [task.id]);

  const targetRef = task.slug ?? task.id;
  const endpointLabel = buildScheduleTriggerEndpointLabel(targetRef);
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://127.0.0.1:4173';
  const curlExample = buildScheduleTriggerCurl(
    origin,
    targetRef,
    issuedToken,
    t('remote.sampleInput'),
  );

  const handleCopyCurl = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(curlExample).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const errorMessage = issueMutation.error?.message ?? revokeMutation.error?.message;
  const busy = issueMutation.isPending || revokeMutation.isPending;

  return (
    <div className="schedules-advanced-card">
      <button
        type="button"
        className="schedules-advanced-toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="schedules-advanced-title">
          <Radio className="size-3.5" aria-hidden="true" />
          <span>{t('remote.title')}</span>
        </span>
        <span className="schedules-advanced-summary">
          {task.remoteTriggerEnabled ? t('remote.summaryOn') : t('remote.summaryOff')}
        </span>
        <ChevronDown
          className={
            open
              ? 'size-4 schedules-advanced-chevron schedules-advanced-chevron-open'
              : 'size-4 schedules-advanced-chevron'
          }
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="schedules-advanced-body">
          {errorMessage ? (
            <div className="schedules-error-banner" role="alert">
              {errorMessage}
            </div>
          ) : null}

          <p className="schedules-muted">{t('remote.agentHint', { target: targetRef })}</p>
          <p className="schedules-muted">{t('remote.description')}</p>

          <div className="schedules-field">
            <span className="schedules-label">{t('remote.endpoint')}</span>
            <code className="schedules-code-inline schedules-mono">{endpointLabel}</code>
          </div>

          <div className="schedules-remote-actions">
            {!task.remoteTriggerEnabled ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  issueMutation.mutate(task.id, {
                    onSuccess: (res) => setIssuedToken(res.token),
                  })
                }
              >
                <KeyRound className="size-3.5" aria-hidden="true" />
                <span>{t('remote.enable')}</span>
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    issueMutation.mutate(task.id, {
                      onSuccess: (res) => setIssuedToken(res.token),
                    })
                  }
                >
                  <RotateCw className="size-3.5" aria-hidden="true" />
                  <span>{t('remote.rotate')}</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    revokeMutation.mutate(task.id, {
                      onSuccess: () => setIssuedToken(null),
                    })
                  }
                >
                  <ShieldOff className="size-3.5" aria-hidden="true" />
                  <span>{t('remote.revoke')}</span>
                </Button>
              </>
            )}

            {task.remoteTriggerEnabled || issuedToken ? (
              <Button type="button" variant="outline" size="sm" onClick={handleCopyCurl}>
                {copied ? (
                  <Check className="size-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="size-3.5" aria-hidden="true" />
                )}
                <span>{copied ? t('remote.copied') : t('remote.copyCurl')}</span>
              </Button>
            ) : null}
          </div>

          {issuedToken ? (
            <div className="schedules-remote-token-box">
              <p className="schedules-remote-warning">{t('remote.tokenOnceWarning')}</p>
              <pre className="schedules-code-block schedules-mono">{curlExample}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
