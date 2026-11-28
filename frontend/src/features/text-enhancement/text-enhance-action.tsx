/**
 * @file 显示可放入受控表单的增强、取消和撤销控件。
 * @implementation 复用标准按钮，提供双语可访问名称与错误提示。
 * @updated 2026-11-28T18:00:00+08:00
 */
import { useRef } from 'react';
import { Sparkles, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { translateError, useUiTranslation } from '@/i18n';
import type { useTextEnhancement } from './use-text-enhancement';

export function TextEnhanceAction({ action }: { action: ReturnType<typeof useTextEnhancement> }) {
  const { t } = useUiTranslation('common');
  const primary = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        ref={primary}
        type="button"
        variant="ghost"
        size="sm"
        disabled={!action.pending && !action.canEnhance}
        onClick={action.pending ? action.cancel : () => void action.enhance()}
      >
        {action.pending ? (
          <X data-icon="inline-start" aria-hidden="true" />
        ) : (
          <Sparkles data-icon="inline-start" aria-hidden="true" />
        )}
        {t(action.pending ? 'enhancement.cancel' : 'enhancement.start')}
      </Button>
      {action.canUndo ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            primary.current?.focus();
            action.undo();
          }}
        >
          <Undo2 data-icon="inline-start" aria-hidden="true" />
          {t('enhancement.undo')}
        </Button>
      ) : null}
      <span role="status" className="sr-only">
        {action.pending ? t('enhancement.pending') : action.canUndo ? t('enhancement.applied') : ''}
      </span>
      {action.error ? (
        <span role="alert" className="text-xs text-destructive">
          {translateError(action.error.cause, t('enhancement.failed'))}
        </span>
      ) : null}
    </div>
  );
}
