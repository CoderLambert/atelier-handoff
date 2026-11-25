/**
 * @file 提供轻量 Git 储藏 (Stash) 折叠面板与管理操作。
 * @implementation 支持储藏列表获取、一键/备注储藏当前改动、Pop 恢复并删除、Apply 应用及 Drop 删除。
 * @updated 2026-11-25T03:42:00+08:00
 */
import { useCallback, useEffect, useState } from 'react';
import { Archive, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUiTranslation } from '@/i18n';
import type { GitStashItem } from '@shared/desktop-git';
import { getDesktopGitBridge } from '@/desktop-git';

export interface GitStashPanelProps {
  cwd?: string;
  onRefreshAll?: () => void;
  showToast?: (msg: string, type?: 'success' | 'error', stderr?: string) => void;
}

export function GitStashPanel({ cwd, onRefreshAll, showToast }: GitStashPanelProps) {
  const { t } = useUiTranslation('git');
  const [stashes, setStashes] = useState<GitStashItem[]>([]);
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [loading, setLoading] = useState(false);

  // 弹窗状态
  const [stashModalOpen, setStashModalOpen] = useState(false);
  const [stashMsg, setStashMsg] = useState('');
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const fetchStashes = useCallback(async () => {
    if (!cwd) return;
    const bridge = getDesktopGitBridge();
    if (!bridge) return;

    try {
      const list = await bridge.stashList(cwd);
      setStashes(list);
    } catch {
      // 忽略静默失败
    }
  }, [cwd]);

  useEffect(() => {
    void fetchStashes();
  }, [fetchStashes]);

  // 执行储藏改动
  const handleStashPush = async () => {
    if (!cwd) return;
    const bridge = getDesktopGitBridge();
    if (!bridge) return;

    setLoading(true);
    try {
      const res = await bridge.stashPush(cwd, stashMsg.trim() || undefined);
      if (!res.success) {
        showToast?.('储藏失败', 'error', res.stderr);
        return;
      }
      showToast?.('已成功储藏当前改动', 'success');
      setStashModalOpen(false);
      setStashMsg('');
      await fetchStashes();
      onRefreshAll?.();
    } catch (err) {
      showToast?.('储藏异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // 执行 Pop
  const handlePop = async (index: number) => {
    if (!cwd) return;
    const bridge = getDesktopGitBridge();
    if (!bridge) return;

    setLoading(true);
    try {
      const res = await bridge.stashPop(cwd, index);
      if (!res.success) {
        showToast?.('应用储藏失败', 'error', res.stderr);
        return;
      }
      showToast?.(`已恢复并删除储藏项 stash@{${index}}`, 'success');
      await fetchStashes();
      onRefreshAll?.();
    } catch (err) {
      showToast?.('恢复储藏异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // 执行 Apply
  const handleApply = async (index: number) => {
    if (!cwd) return;
    const bridge = getDesktopGitBridge();
    if (!bridge) return;

    setLoading(true);
    try {
      const res = await bridge.stashApply(cwd, index);
      if (!res.success) {
        showToast?.('应用储藏失败', 'error', res.stderr);
        return;
      }
      showToast?.(`已应用储藏项 stash@{${index}}`, 'success');
      onRefreshAll?.();
    } catch (err) {
      showToast?.('应用储藏异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // 执行 Drop
  const handleDrop = async () => {
    if (dropIndex === null || !cwd) return;
    const bridge = getDesktopGitBridge();
    if (!bridge) return;

    setLoading(true);
    try {
      const res = await bridge.stashDrop(cwd, dropIndex);
      if (!res.success) {
        showToast?.('删除储藏失败', 'error', res.stderr);
        return;
      }
      showToast?.(`已删除储藏项 stash@{${dropIndex}}`, 'success');
      setDropIndex(null);
      await fetchStashes();
    } catch (err) {
      showToast?.('删除储藏异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-border bg-card/40">
      <div className="px-3 py-2 flex items-center justify-between">
        <button
          type="button"
          aria-expanded={!isCollapsed}
          onClick={() => setIsCollapsed((prev) => !prev)}
          className="flex items-center gap-1.5 text-xs font-semibold text-foreground hover:text-primary transition-colors select-none"
        >
          <ChevronDown
            className={`w-3.5 h-3.5 transition-transform duration-150 ${isCollapsed ? '-rotate-90' : ''}`}
            aria-hidden="true"
          />
          <span>{t('stash.label')}</span>
          <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-muted text-muted-foreground font-normal">
            {stashes.length}
          </span>
        </button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px] font-medium"
          onClick={() => setStashModalOpen(true)}
        >
          <Plus className="w-3 h-3 mr-1" aria-hidden="true" />
          <span>{t('stash.stashCurrent')}</span>
        </Button>
      </div>

      {!isCollapsed && (
        <div className="max-h-36 overflow-y-auto px-2 pb-2 space-y-1">
          {stashes.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">{t('stash.empty')}</div>
          ) : (
            stashes.map((s) => (
              <div
                key={`stash-${s.index}`}
                className="group p-1.5 rounded-md border border-border/60 bg-background/50 hover:bg-accent/40 flex items-center justify-between gap-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10.5px] text-muted-foreground">
                      {t('stash.refPrefix')}{`{${s.index}}`}
                    </span>
                    <span className="truncate text-foreground font-medium">{s.message}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-5 px-1.5 text-[10.5px]"
                    disabled={loading}
                    onClick={() => void handlePop(s.index)}
                  >
                    {t('stash.popBtn')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[10.5px]"
                    disabled={loading}
                    onClick={() => void handleApply(s.index)}
                  >
                    {t('stash.applyBtn')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[10.5px] text-destructive hover:text-destructive hover:bg-destructive/10"
                    disabled={loading}
                    onClick={() => setDropIndex(s.index)}
                  >
                    {t('stash.dropBtn')}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* 储藏当前改动弹窗 */}
      <Dialog open={stashModalOpen} onOpenChange={(o) => !loading && setStashModalOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Archive className="w-4 h-4" aria-hidden="true" />
              <span>{t('stash.stashCurrent')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs pt-1">
              {t('stash.dialogDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="py-3">
            <input
              type="text"
              autoFocus
              value={stashMsg}
              onChange={(e) => setStashMsg(e.target.value)}
              placeholder={t('stash.messagePlaceholder')}
              className="w-full px-2.5 py-1.5 text-xs rounded-md bg-background border border-input focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => setStashModalOpen(false)}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="button" size="sm" disabled={loading} onClick={() => void handleStashPush()}>
              {loading ? t('stash.stashing') : t('stash.stashSubmit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除储藏确认弹窗 */}
      <Dialog open={dropIndex !== null} onOpenChange={(o) => !loading && !o && setDropIndex(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-destructive" aria-hidden="true" />
              <span>{t('stash.dropConfirmTitle')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs pt-2">
              {dropIndex !== null && t('stash.dropConfirmDesc', { index: dropIndex })}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="mt-4 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => setDropIndex(null)}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={loading}
              onClick={() => void handleDrop()}
            >
              {loading ? t('stash.dropping') : t('stash.drop')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
