/**
 * @file 提供会话内的人工终端面板。
 * @implementation 显式创建多个 PTY，确认终止，按会话选择资源；隐藏仅释放视图，状态和错误通过双语提示呈现。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, Plus, Square, TerminalSquare, X } from 'lucide-react';
import { terminalHasActiveProcess, type TerminalRecord } from '@shared/terminal';
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
import type { PanelInstance, PanelViewProps, SessionPanelTarget } from '@/panel-sdk';
import { useTerminalWorkspace, type TerminalLaunchIntent } from './hooks/use-terminal-workspace';
import { getTerminalClient } from './terminal-client';
import { TerminalViewport } from './terminal-viewport';
import {
  terminalErrorMessage,
  terminalStateKeys,
  terminalUnavailableKeys,
} from './terminal-errors';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';

export type { TerminalLaunchIntent } from './hooks/use-terminal-workspace';
export interface TerminalPanelProps extends PanelViewProps<
  PanelInstance<'atelier.terminal', SessionPanelTarget>
> {
  expectedWorkspaceId: string | null;
  canCreate: boolean;
  archived: boolean;
  launch?: TerminalLaunchIntent;
}
export default function TerminalPanel(props: TerminalPanelProps) {
  const { t } = useUiTranslation('terminal');
  const { instance, expectedWorkspaceId, canCreate, archived, launch } = props;
  const scope = {
    sessionId: instance.target.sessionId,
    projectId: instance.target.projectId,
    expectedWorkspaceId,
    canCreate,
  };
  const workspace = useTerminalWorkspace(scope, launch);
  const [ending, setEnding] = useState<TerminalRecord>();
  const endTrigger = useRef<HTMLButtonElement>(null);
  const { selected, capabilities, list } = workspace;
  const attachable =
    selected && ['awaiting-attach', 'starting', 'running', 'exited'].includes(selected.state);
  const client = useMemo(
    () => (selected && attachable ? getTerminalClient(selected, workspace.cache) : undefined),
    [selected?.runtimeId, selected?.terminalId, attachable, workspace.cache],
  );
  const limit = workspace.records.length >= (capabilities.data?.limits.perSession ?? 4);
  const busy = workspace.create.isPending || workspace.close.isPending;
  const unavailable =
    capabilities.data && !capabilities.data.supported && capabilities.data.reason !== 'available'
      ? t(terminalUnavailableKeys[capabilities.data.reason])
      : undefined;
  const error = workspace.create.error ?? workspace.close.error ?? list.error ?? capabilities.error;
  const closeTerminal = async (record: TerminalRecord) => {
    try {
      await workspace.end(record);
      setEnding(undefined);
    } catch {
      /* Keep the explicit target and failure visible. */
    }
  };
  return (
    <section
      className="terminal-panel"
      data-expanded={props.expanded || undefined}
      role={props.expanded ? 'dialog' : 'region'}
      aria-modal={props.expanded || undefined}
      aria-label={t('title')}
    >
      <header className="terminal-heading">
        <h2>
          <TerminalSquare aria-hidden="true" />
          {t('title')}
        </h2>
        <div className="terminal-actions">
          {workspace.records.length > 0 && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('new')}
              title={t('new')}
              disabled={busy || limit || !canCreate || !capabilities.data?.supported || !list.data}
              onClick={workspace.newTerminal}
            >
              <Plus aria-hidden="true" />
            </Button>
          )}
          {props.expandable && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t(props.expanded ? 'dock' : 'expand')}
              onClick={props.onRequestExpand}
            >
              {props.expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('hide')}
            title={t('hide')}
            onClick={props.onRequestHide}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>
      {workspace.records.length > 0 && (
        <div className="terminal-tabs" role="group" aria-label={t('tabs')}>
          {workspace.records.map((terminal, index) => (
            <Button
              key={terminal.terminalId}
              size="sm"
              variant={selected?.terminalId === terminal.terminalId ? 'secondary' : 'ghost'}
              aria-pressed={selected?.terminalId === terminal.terminalId}
              title={`${t('tab', { number: index + 1 })} · ${t(terminalStateKeys[terminal.state])}`}
              onClick={() => workspace.choose(terminal)}
            >
              {t('tab', { number: index + 1 })}
              <span className="terminal-tab-state">{t(terminalStateKeys[terminal.state])}</span>
            </Button>
          ))}
        </div>
      )}
      {workspace.runtimeChanged && (
        <p className="terminal-notice" role="status">
          {t('runtimeChanged')}
        </p>
      )}
      {error && (
        <div className="terminal-feedback" role="alert">
          <p>{terminalErrorMessage(error)}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (workspace.retryCreate) workspace.retryCreate();
              else {
                void capabilities.refetch();
                if (capabilities.data?.supported) void list.refetch();
              }
            }}
          >
            {t('retry')}
          </Button>
        </div>
      )}
      {unavailable ? (
        <p className="terminal-feedback" role="status">
          {unavailable}
        </p>
      ) : capabilities.isPending || (capabilities.data?.supported && list.isPending) ? (
        <p className="terminal-feedback" role="status">
          {t('loading')}
        </p>
      ) : selected ? (
        <>
          <div className="terminal-metadata">
            <span className="terminal-cwd" title={t('cwd', { path: selected.initialCwd })}>
              {selected.initialCwd}
            </span>
            <span title={t('shell', { name: selected.shellName })}>{selected.shellName}</span>
            <Button
              ref={endTrigger}
              size="icon-xs"
              variant="ghost"
              disabled={busy}
              aria-label={t(terminalHasActiveProcess(selected.state) ? 'end' : 'remove')}
              title={t(terminalHasActiveProcess(selected.state) ? 'end' : 'remove')}
              onClick={() =>
                terminalHasActiveProcess(selected.state)
                  ? setEnding(selected)
                  : void closeTerminal(selected)
              }
            >
              <Square aria-hidden="true" />
            </Button>
          </div>
          {selected.state === 'exited' && (
            <p className="terminal-notice" role="status">
              {selected.exitSignal !== null
                ? t('signal', { signal: selected.exitSignal })
                : t('exit', { code: selected.exitCode ?? 0 })}
            </p>
          )}
          {client ? (
            <TerminalViewport
              key={`${selected.runtimeId}:${selected.terminalId}`}
              client={client}
              focusRequest={workspace.focusRequest}
            />
          ) : (
            <p className="terminal-feedback" role="status">
              {t(terminalStateKeys[selected.state])}
            </p>
          )}
        </>
      ) : (
        !error && (
          <div className="terminal-empty">
            <p>{t('empty')}</p>
            <p>{t('emptyHint')}</p>
            <Button
              onClick={workspace.newTerminal}
              disabled={busy || !canCreate || !capabilities.data?.supported || !list.data}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              {t(workspace.create.isPending ? 'creating' : 'new')}
            </Button>
          </div>
        )
      )}
      {limit && (
        <p className="terminal-notice">
          {t('limit', { count: capabilities.data?.limits.perSession ?? 4 })}
        </p>
      )}
      {!canCreate && !unavailable && (
        <p className="terminal-notice">
          {t(archived ? 'unavailable.archived' : 'unavailable.workspace')}
        </p>
      )}
      <Dialog
        open={Boolean(ending)}
        onOpenChange={(open) => {
          if (!open && !workspace.close.isPending) setEnding(undefined);
        }}
      >
        <DialogContent
          showCloseButton={!workspace.close.isPending}
          onCloseAutoFocus={(event) => {
            if (endTrigger.current?.isConnected) {
              event.preventDefault();
              endTrigger.current.focus({ preventScroll: true });
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('endTitle')}</DialogTitle>
            <DialogDescription>{t('endDescription')}</DialogDescription>
          </DialogHeader>
          {workspace.close.error && (
            <p role="alert">{terminalErrorMessage(workspace.close.error)}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={workspace.close.isPending}
              onClick={() => setEnding(undefined)}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={workspace.close.isPending}
              onClick={() => ending && void closeTerminal(ending)}
            >
              {t('end')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
