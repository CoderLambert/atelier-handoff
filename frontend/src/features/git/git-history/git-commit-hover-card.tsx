/**
 * @file 展示提交历史行的悬停元数据卡片。
 * @implementation 经由 Portal 挂载以防截断，按提交 Hash 缓存变更统计并展示完整标题、正文摘要、时间和完整 Hash。
 * @updated 2026-11-25T03:25:00+08:00
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, FileText } from 'lucide-react';
import { useUiTranslation } from '@/i18n';
import { desktopGitBridge } from '@/desktop-git';
import type { GitCommitStats } from '@shared/desktop-git';
import type { GitCommit } from '@shared/git-workbench';

const commitStatsCache = new Map<string, GitCommitStats>();

export interface GitCommitHoverCardProps {
  commit: GitCommit;
  rect: DOMRect;
  cwd?: string;
  dateFormat: Intl.DateTimeFormat;
}

export function GitCommitHoverCard({
  commit,
  rect,
  cwd,
  dateFormat,
}: GitCommitHoverCardProps) {
  const { t } = useUiTranslation('git');
  const [stats, setStats] = useState<GitCommitStats | null>(() => {
    return commitStatsCache.get(commit.oid) ?? null;
  });
  const [loading, setLoading] = useState<boolean>(() => {
    return !commitStatsCache.has(commit.oid);
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const cached = commitStatsCache.get(commit.oid);
    if (cached) {
      setStats(cached);
      setLoading(false);
      return;
    }

    const bridge = desktopGitBridge();
    if (!bridge || !cwd) {
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    bridge
      .getCommitStats(cwd, commit.oid)
      .then((res) => {
        if (!active) return;
        commitStatsCache.set(commit.oid, res);
        setStats(res);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [commit.oid, cwd]);

  const handleCopyHash = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(commit.oid);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  // 坐标计算：优先渲染于悬停行下方，若靠近屏幕底部则翻转至上方
  const cardWidth = 380;
  const estimatedHeight = 180;
  const spaceBelow = typeof window !== 'undefined' ? window.innerHeight - rect.bottom : 300;
  const showAbove = spaceBelow < estimatedHeight + 16 && rect.top > estimatedHeight + 16;

  const top = showAbove ? rect.top - estimatedHeight - 6 : rect.bottom + 6;
  const left =
    typeof window !== 'undefined'
      ? Math.max(12, Math.min(rect.left, window.innerWidth - cardWidth - 12))
      : rect.left;

  const fullDate = new Date(commit.date).toLocaleString(undefined, {
    dateStyle: 'full',
    timeStyle: 'medium',
  });

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="git-hover-card-portal git-commit-hover-card"
      style={{
        position: 'fixed',
        top: `${top}px`,
        left: `${left}px`,
        width: `${cardWidth}px`,
        zIndex: 9999,
      }}
      role="tooltip"
    >
      <div className="git-card-header">
        <h4 className="git-card-title">{commit.subject || t('history.untitled')}</h4>
        <button
          type="button"
          className="git-card-copy-btn"
          title={copied ? t('history.hashCopied') : t('history.copyHash')}
          onClick={handleCopyHash}
        >
          {copied ? (
            <Check className="git-copy-icon git-card-copied-icon" aria-hidden="true" />
          ) : (
            <Copy className="git-copy-icon" aria-hidden="true" />
          )}
          <span className="font-mono text-[11px]">{commit.oid.slice(0, 10)}</span>
        </button>
      </div>

      {/* 提交正文（最多 4 行截断） */}
      {stats?.body && stats.body !== commit.subject && (
        <p className="git-card-body">{stats.body}</p>
      )}

      {/* 统计信息（文件数、+新增绿色、-删除红色） */}
      <div className="git-card-stats-row">
        {loading ? (
          <span className="text-[11px] text-muted-foreground">{t('card.loadingStats')}</span>
        ) : stats ? (
          <div className="flex items-center gap-2 text-[11.5px]">
            <span className="flex items-center gap-1 text-muted-foreground">
              <FileText className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{t('card.changes', { count: stats.filesChanged })}</span>
            </span>
            <span className="git-stat-add">
              +{stats.insertions}
            </span>
            <span className="git-stat-del">
              -{stats.deletions}
            </span>
          </div>
        ) : null}
      </div>

      <div className="git-card-footer">
        <span className="git-card-author">{commit.author}</span>
        <span>·</span>
        <span className="git-card-date" title={fullDate}>
          {dateFormat.format(new Date(commit.date))}
        </span>
      </div>
    </div>,
    document.body,
  );
}
