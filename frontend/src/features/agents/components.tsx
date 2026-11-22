import { useUiTranslation } from '@/i18n';
import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function AgentDialog({
  title,
  description,
  busy = false,
  wide = false,
  onClose,
  children,
}: {
  title: string;
  description: string;
  busy?: boolean;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className={`agent-dialog${wide ? ' agent-dialog-wide' : ''}`}
        showCloseButton={!busy}
        aria-busy={busy}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function AgentProblems({ issues, label }: { issues: string[]; label?: string }) {
  const { t } = useUiTranslation('extensions');
  return issues.length ? (
    <div className="agent-problems" role="alert">
      <strong>{label ?? t('agentEditor.problems')}</strong>
      <ul>
        {[...new Set(issues)].map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </div>
  ) : null;
}
