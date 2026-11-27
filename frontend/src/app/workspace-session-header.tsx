/**
 * @file 渲染会话顶部的代理版本、工作树状态与分叉来源栏。
 * @implementation 将会话头部元信息与操作按钮从 Workspace 主布局组件拆出。
 * @updated 2026-11-27T12:48:00-06:00
 */
import type { Session } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import { SessionWorktree } from '@/features/git/session-worktree';
import { useUiTranslation } from '@/i18n';

export interface WorkspaceSessionHeaderProps {
  snapshot: Snapshot;
  sessions: readonly Session[];
  upgradePending: boolean;
  onUpgradeAgent: (sessionId: string, revisionId: string) => void;
  onOpenAgents: () => void;
  onShowWorktree: () => void;
  onRefreshWorktree: () => Promise<void>;
  onOpenOriginMessage: (sessionId: string, messageId: string) => void;
}

export function WorkspaceSessionHeader({
  snapshot,
  sessions,
  upgradePending,
  onUpgradeAgent,
  onOpenAgents,
  onShowWorktree,
  onRefreshWorktree,
  onOpenOriginMessage,
}: WorkspaceSessionHeaderProps) {
  const { t } = useUiTranslation('workbench');
  const upgradableAgent = snapshot.agent?.canUpgrade ? snapshot.agent : undefined;

  return (
    <header className="session-header">
      <div className="session-title-row">
        {upgradableAgent ? (
          <Button
            size="sm"
            disabled={upgradePending}
            onClick={() => onUpgradeAgent(snapshot.session.id, upgradableAgent.revisionId)}
          >
            {t('session.useNewVersion')}
          </Button>
        ) : null}
        {snapshot.agent ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onOpenAgents}
            title={t('session.manageAgent')}
          >
            {t('session.agentVersion', {
              name: snapshot.agent.name,
              version: snapshot.agent.version,
            })}
          </Button>
        ) : null}
      </div>
      {snapshot.workspace ? (
        <SessionWorktree
          session={snapshot.session}
          workspace={snapshot.workspace}
          onShowTree={onShowWorktree}
          onRefresh={onRefreshWorktree}
        />
      ) : null}
      {snapshot.session.fork
        ? (() => {
            const origin = snapshot.session.fork;
            const label =
              origin.kind === 'rewind' ? t('session.beforeRewind') : t('session.source');
            const exists = sessions.some((item) => item.id === origin.sourceSessionId);
            return exists ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onOpenOriginMessage(origin.sourceSessionId, origin.sourceMessageId)}
              >
                {label} · {origin.sourceTitle}
              </Button>
            ) : (
              <p className="session-meta">
                {t('session.sourceUnavailable', {
                  label,
                  title: origin.sourceTitle,
                })}
              </p>
            );
          })()
        : null}
    </header>
  );
}
