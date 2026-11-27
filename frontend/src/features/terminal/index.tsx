/**
 * @file 提供会话内的人工终端面板。
 * @implementation 显式创建多个 PTY，通过标签结束指定终端；共享布局按钮仅改变可见性和停靠方式。
 * @updated 2026-11-27T02:41:56+08:00
 */
import { useMemo } from 'react';
import { Plus, TerminalSquare, X } from 'lucide-react';
import type { TerminalRecord } from '@shared/terminal';
import { PanelLayoutButtons } from '@/components/panel-layout-buttons';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import type { PanelInstance, PanelViewProps, SessionPanelTarget } from '@/panel-sdk';
import { useTerminalWorkspace, type TerminalLaunchIntent } from './hooks/use-terminal-workspace';
import { getTerminalClient } from './terminal-client';
import { TerminalConnectionStatus, TerminalViewport } from './terminal-viewport';
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
    } catch {
      /* The close mutation keeps the failure visible. */
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
        <div className="terminal-heading-content">
          {workspace.records.length > 0 ? (
            <div className="terminal-tabs" role="group" aria-label={t('tabs')}>
              {workspace.records.map((terminal, index) => (
                <span
                  key={terminal.terminalId}
                  className="terminal-tab"
                  data-selected={selected?.terminalId === terminal.terminalId || undefined}
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={selected?.terminalId === terminal.terminalId}
                    title={`${t('tab', { number: index + 1 })} · ${t(terminalStateKeys[terminal.state])}`}
                    onClick={() => workspace.choose(terminal)}
                  >
                    <TerminalSquare data-icon="inline-start" aria-hidden="true" />
                    {terminal.shellName || t('tab', { number: index + 1 })}
                    {terminal.state !== 'running' && (
                      <span className="terminal-tab-state">
                        {t(terminalStateKeys[terminal.state])}
                      </span>
                    )}
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t('closeTab', { number: index + 1 })}
                    title={t('closeTab', { number: index + 1 })}
                    disabled={busy}
                    onClick={() => void closeTerminal(terminal)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </span>
              ))}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('new')}
                title={t('new')}
                disabled={
                  busy || limit || !canCreate || !capabilities.data?.supported || !list.data
                }
                onClick={workspace.newTerminal}
              >
                <Plus aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <h2>
              <TerminalSquare aria-hidden="true" />
              {t('title')}
            </h2>
          )}
        </div>
        <div className="terminal-actions">
          {client && (
            <TerminalConnectionStatus
              key={`${selected?.runtimeId}:${selected?.terminalId}`}
              client={client}
            />
          )}
          <PanelLayoutButtons
            layout={props}
            expandLabel={t('expand')}
            dockLabel={t('dock')}
            collapseLabel={t('hide')}
          />
        </div>
      </header>
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
    </section>
  );
}
