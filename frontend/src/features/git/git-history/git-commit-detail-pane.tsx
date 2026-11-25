/**
 * @file 展示选中提交的差异详情，提供文件级快速过滤导航与超大变更分块折叠以优化性能。
 * @implementation 支持单文件/全文件切换、按文件卡片折叠、提交元数据展示与快速复制关闭。
 * @updated 2026-11-25T13:23:00+08:00
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileCode2,
  Layers,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import { useGitCommitDiff } from '@/use-query/git/use-git-commit-diff';
import type { GitCommit } from '@shared/git-workbench';
import { describeGitPatch, type PatchFile } from '../git-diff-model';
import { PatchFileCard } from '../git-diff';

export interface GitCommitDetailPaneProps {
  projectId: string;
  commitOid: string;
  commitInfo?: GitCommit;
  onClose: () => void;
  showToast?: (message: string, type?: 'success' | 'error', stderr?: string) => void;
}

export function GitCommitDetailPane({
  projectId,
  commitOid,
  commitInfo,
  onClose,
  showToast,
}: GitCommitDetailPaneProps) {
  const { t, locale } = useUiTranslation('git');
  const patch = useGitCommitDiff(projectId, commitOid);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const format = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  // 解析并缓存当前提交的所有文件改动
  const files: PatchFile[] = useMemo(() => {
    if (!patch.data?.text) return [];
    return describeGitPatch(patch.data.text, undefined);
  }, [patch.data?.text]);

  // 当切换提交时，重置选中文件；如果文件数 > 4，折叠第 4 个之后的文件或大文件以杜绝卡顿
  useEffect(() => {
    setSelectedPath(null);
    if (files.length > 4) {
      const initialCollapsed = new Set<string>();
      files.forEach((f, idx) => {
        if (!f.path) return;
        const lineCount = f.kind === 'text' ? f.added + f.removed : 0;
        if (idx >= 3 || lineCount > 200) {
          initialCollapsed.add(f.path);
        }
      });
      setCollapsedPaths(initialCollapsed);
    } else {
      setCollapsedPaths(new Set());
    }
  }, [commitOid, files]);

  // 统计总增删行数
  const { totalAdded, totalRemoved } = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const f of files) {
      if (f.kind === 'text') {
        added += f.added;
        removed += f.removed;
      }
    }
    return { totalAdded: added, totalRemoved: removed };
  }, [files]);

  const handleCopyHash = useCallback(() => {
    void navigator.clipboard.writeText(commitOid).then(() => {
      setCopied(true);
      showToast?.(t('diff.hashCopied'), 'success');
      setTimeout(() => setCopied(false), 2000);
    });
  }, [commitOid, showToast, t]);

  const toggleCollapse = useCallback((path: string | undefined) => {
    if (!path) return;
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    setCollapsedPaths(new Set());
  }, []);

  const handleCollapseAll = useCallback(() => {
    const all = new Set<string>();
    files.forEach((f) => {
      if (f.path) all.add(f.path);
    });
    setCollapsedPaths(all);
  }, [files]);

  // 过滤后的显示文件列表
  const displayedFiles = useMemo(() => {
    if (!selectedPath) return files;
    const matched = files.filter((f) => f.path === selectedPath);
    return matched.length > 0 ? matched : files;
  }, [files, selectedPath]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-card overflow-hidden">
      {/* 1. 顶部提交摘要与关闭按钮 */}
      <div className="git-commit-detail-header">
        <div className="git-commit-detail-top-row">
          <div className="flex items-center gap-2 min-w-0">
            <span className="git-commit-hash-pill" title={commitOid}>
              <code>{commitOid.slice(0, 10)}</code>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              aria-label={t('diff.copyHash')}
              title={t('diff.copyHash')}
              onClick={handleCopyHash}
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
              ) : (
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
              )}
            </Button>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            aria-label={t('diff.closeDetail')}
            title={t('diff.closeDetail')}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </Button>
        </div>

        {commitInfo && (
          <div className="git-commit-subject truncate" title={commitInfo.subject}>
            {commitInfo.subject}
          </div>
        )}

        <div className="git-commit-meta">
          {commitInfo && <span>{commitInfo.author}</span>}
          {commitInfo && <span>·</span>}
          <span>{t('diff.filesCount', { count: files.length })}</span>
          <span className="git-diff-added font-mono text-xs">+{format.format(totalAdded)}</span>
          <span className="git-diff-removed font-mono text-xs">−{format.format(totalRemoved)}</span>
        </div>
      </div>

      {/* 2. 变更文件快速导航栏 */}
      {files.length > 1 && (
        <div className="git-commit-file-bar">
          <div
            className="git-commit-file-pills"
            onWheel={(e) => {
              if (e.deltaY !== 0) {
                e.preventDefault();
                e.currentTarget.scrollLeft += e.deltaY;
              }
            }}
          >
            <button
              type="button"
              className="git-commit-file-pill"
              aria-pressed={selectedPath === null}
              onClick={() => setSelectedPath(null)}
            >
              <Layers className="w-3 h-3" aria-hidden="true" />
              <span>{t('diff.allFiles', { count: files.length })}</span>
            </button>

            {files.map((f) => {
              if (!f.path) return null;
              const name = f.path.split('/').pop() || f.path;
              const isSelected = selectedPath === f.path;
              return (
                <button
                  key={f.path}
                  type="button"
                  className="git-commit-file-pill"
                  aria-pressed={isSelected}
                  title={f.path}
                  onClick={() => setSelectedPath(f.path ?? null)}
                >
                  <FileCode2 className="w-3 h-3 shrink-0" aria-hidden="true" />
                  <span className="truncate max-w-[140px]">{name}</span>
                  {f.kind === 'text' && (
                    <span className="text-[10px] opacity-75 tabular-nums">
                      +{f.added} -{f.removed}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {selectedPath === null && files.length > 2 && (
            <div className="flex items-center gap-1 shrink-0 ml-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={handleExpandAll}
              >
                <ChevronDown className="w-3 h-3 mr-0.5" aria-hidden="true" />
                <span>{t('diff.expandAll')}</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={handleCollapseAll}
              >
                <ChevronUp className="w-3 h-3 mr-0.5" aria-hidden="true" />
                <span>{t('diff.collapseAll')}</span>
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 3. 差异内容滚动渲染区 */}
      {patch.isLoading ? (
        <div className="flex-1 min-h-0 p-8 text-center text-xs text-muted-foreground animate-pulse">
          {t('board.loading')}
        </div>
      ) : patch.error ? (
        <div className="flex-1 min-h-0 p-6 text-center text-xs text-destructive">
          <p>{patch.error instanceof Error ? patch.error.message : String(patch.error)}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void patch.refetch()}
          >
            {t('board.retry')}
          </Button>
        </div>
      ) : displayedFiles.length === 0 ? (
        <div className="flex-1 min-h-0 p-8 text-center text-xs text-muted-foreground">
          {t(patch.data?.binary ? 'diff.binary' : 'diff.empty')}
        </div>
      ) : (
        <div className="git-diff-code" role="region" aria-label={t('diff.preview')} tabIndex={0}>
          {displayedFiles.map((file, idx) => {
            const p = file.path ?? `file-${idx}`;
            const isCollapsed = selectedPath === null && collapsedPaths.has(p);
            const isSingle = displayedFiles.length === 1;
            const lineCount = file.kind === 'text' ? file.added + file.removed : 0;
            // 超大文件跳过沉重的 Shiki 逐行分词高亮，采用快速纯文本对比渲染
            const shouldHighlight = lineCount <= 350;

            return (
              <PatchFileCard
                key={p}
                file={file}
                filename={file.path}
                highlight={shouldHighlight}
                collapsible={!isSingle}
                isCollapsed={isCollapsed}
                onToggleCollapse={() => toggleCollapse(file.path)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
