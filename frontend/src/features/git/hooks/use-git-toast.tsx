/**
 * @file 提供 Git 看板内部的轻量 Toast 通知与错误详情弹窗。
 * @implementation 支持 success/error 状态通知，错误附带 stderr 查看详情弹窗，并在超时后自动淡出。
 * @updated 2026-11-25T03:30:00+08:00
 */
import { useCallback, useState } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUiTranslation } from '@/i18n';

export interface GitToastItem {
  id: string;
  message: string;
  type: 'success' | 'error';
  stderr?: string;
}

export function useGitToast() {
  const { t } = useUiTranslation('git');
  const [toasts, setToasts] = useState<GitToastItem[]>([]);
  const [activeStderr, setActiveStderr] = useState<{ message: string; stderr: string } | null>(
    null,
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: 'success' | 'error' = 'success', stderr?: string) => {
      const id = Math.random().toString(36).slice(2, 9);
      setToasts((prev) => [...prev, { id, message, type, stderr }]);
      if (type === 'success') {
        setTimeout(() => {
          removeToast(id);
        }, 4000);
      }
    },
    [removeToast],
  );

  const ToastRenderer = useCallback(() => {
    if (toasts.length === 0 && !activeStderr) return null;

    return (
      <>
        {toasts.length > 0 && (
          <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
            {toasts.map((toast) => (
              <div
                key={toast.id}
                className={`pointer-events-auto flex items-start gap-2.5 p-3 rounded-lg border shadow-lg text-xs animate-in slide-in-from-bottom-2 duration-200 ${
                  toast.type === 'error'
                    ? 'border-destructive/40 bg-popover text-popover-foreground'
                    : 'border-border bg-popover text-popover-foreground'
                }`}
                role="status"
              >
                {toast.type === 'error' ? (
                  <AlertCircle
                    className="w-4 h-4 text-destructive shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                ) : (
                  <CheckCircle2
                    className="w-4 h-4 text-success shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-medium leading-snug break-words">{toast.message}</p>
                  {toast.stderr && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="p-0 h-auto text-[11px] text-destructive underline mt-1"
                      onClick={() =>
                        setActiveStderr({ message: toast.message, stderr: toast.stderr! })
                      }
                    >
                      {t('sync.viewDetails')}
                    </Button>
                  )}
                </div>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground shrink-0 p-0.5"
                  onClick={() => removeToast(toast.id)}
                  aria-label={t('toast.close')}
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        {activeStderr && (
          <Dialog open onOpenChange={(open) => !open && setActiveStderr(null)}>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>{activeStderr.message}</DialogTitle>
                <DialogDescription className="font-mono text-xs whitespace-pre-wrap max-h-80 overflow-auto bg-muted p-3 rounded-md border border-border mt-2 text-foreground">
                  {activeStderr.stderr}
                </DialogDescription>
              </DialogHeader>
            </DialogContent>
          </Dialog>
        )}
      </>
    );
  }, [toasts, activeStderr, removeToast, t]);

  return {
    showToast,
    ToastRenderer,
  };
}
