/**
 * @file 编排终端面板的显式创建、选择与关闭。
 * @implementation 绑定点击时的运行时和会话目录，列表加载后消费一次启动意图，失败重试沿用同一终端身份。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { useEffect, useRef, useState } from 'react';
import type { TerminalRecord } from '@shared/terminal';
import { useTerminalCapabilities } from '@/use-query/terminal/use-terminal-capabilities';
import { useListTerminals } from '@/use-query/terminal/use-list-terminals';
import { useCreateTerminal } from '@/use-query/terminal/use-create-terminal';
import { useCloseTerminal } from '@/use-query/terminal/use-close-terminal';
import { useTerminalCache } from '@/use-query/terminal/use-terminal-cache';
import {
  activateTerminalRuntime,
  forgetTerminalClient,
  reconcileTerminalClients,
} from '../terminal-client';
import {
  observeTerminalSelectionRuntime,
  selectTerminal,
  useTerminalSelection,
} from '../terminal-ui-state';

export interface TerminalLaunchIntent {
  terminalId: string;
  runtimeId: string;
  sessionId: string;
  projectId: string;
  expectedWorkspaceId: string | null;
}
export interface TerminalScope {
  sessionId: string;
  projectId: string;
  expectedWorkspaceId: string | null;
  canCreate: boolean;
}
export function useTerminalWorkspace(scope: TerminalScope, launch?: TerminalLaunchIntent) {
  const capabilities = useTerminalCapabilities();
  const runtimeId = capabilities.data?.runtimeId;
  const list = useListTerminals(runtimeId, scope.sessionId, capabilities.data?.supported === true);
  const create = useCreateTerminal();
  const close = useCloseTerminal();
  const cache = useTerminalCache();
  const selection = useTerminalSelection(runtimeId, scope.sessionId);
  const [focusRequest, setFocusRequest] = useState(0);
  const [runtimeChanged, setRuntimeChanged] = useState(false);
  const [activeRuntime, setActiveRuntime] = useState<string>();
  const [failedIntent, setFailedIntent] = useState<TerminalLaunchIntent>();
  const pending = useRef(false);
  const consumed = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const currentTarget = useRef({ runtimeId, ...scope });
  currentTarget.current = { runtimeId, ...scope };
  function isCurrentTarget(intent: TerminalLaunchIntent) {
    const current = currentTarget.current;
    return (
      current.runtimeId === intent.runtimeId &&
      current.sessionId === intent.sessionId &&
      current.projectId === intent.projectId &&
      current.expectedWorkspaceId === intent.expectedWorkspaceId
    );
  }
  const records = list.data?.terminals ?? [];
  const selected =
    activeRuntime === runtimeId
      ? (records.find((item) => item.terminalId === selection) ?? records[0])
      : undefined;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!runtimeId) return;
    activateTerminalRuntime(runtimeId);
    if (observeTerminalSelectionRuntime(runtimeId)) setRuntimeChanged(true);
    setActiveRuntime(runtimeId);
  }, [runtimeId]);
  useEffect(() => {
    if (!list.data || !runtimeId || activeRuntime !== runtimeId) return;
    reconcileTerminalClients(runtimeId, scope.sessionId, list.data.terminals);
    if (selected?.terminalId !== selection)
      selectTerminal(runtimeId, scope.sessionId, selected?.terminalId);
  }, [list.data, runtimeId, activeRuntime, scope.sessionId, selected?.terminalId, selection]);

  async function execute(intent: TerminalLaunchIntent) {
    if (pending.current || !isCurrentTarget(intent) || !scope.canCreate) return;
    pending.current = true;
    setFailedIntent(undefined);
    try {
      const terminal = await create.mutateAsync({
        sessionId: intent.sessionId,
        request: {
          runtimeId: intent.runtimeId,
          terminalId: intent.terminalId,
          expectedWorkspaceId: intent.expectedWorkspaceId,
          cols: 80,
          rows: 24,
        },
      });
      selectTerminal(intent.runtimeId, intent.sessionId, terminal.terminalId);
      if (mounted.current && isCurrentTarget(intent)) setFocusRequest((current) => current + 1);
    } catch {
      if (mounted.current && isCurrentTarget(intent)) setFailedIntent(intent);
    } finally {
      pending.current = false;
    }
  }
  useEffect(() => {
    if (
      !launch ||
      consumed.current === launch.terminalId ||
      !list.data ||
      !capabilities.data ||
      activeRuntime !== runtimeId
    )
      return;
    consumed.current = launch.terminalId;
    if (launch.runtimeId !== runtimeId) {
      setRuntimeChanged(true);
      return;
    }
    if (!isCurrentTarget(launch)) return;
    if (records.length) {
      if (selected) selectTerminal(launch.runtimeId, launch.sessionId, selected.terminalId);
      setFocusRequest((current) => current + 1);
    } else void execute(launch);
  }, [launch, list.data, capabilities.data, runtimeId, activeRuntime]);

  const newTerminal = () => {
    if (
      !runtimeId ||
      !capabilities.data?.supported ||
      !list.data ||
      !scope.canCreate ||
      pending.current
    )
      return;
    void execute({ ...scope, runtimeId, terminalId: crypto.randomUUID() });
  };
  const choose = (terminal: TerminalRecord) => {
    selectTerminal(terminal.runtimeId, terminal.sessionId, terminal.terminalId);
    setFocusRequest((current) => current + 1);
  };
  const end = async (terminal: TerminalRecord) => {
    const result = await close.mutateAsync(terminal);
    if (result.state === 'closed') forgetTerminalClient(terminal);
    return result;
  };
  return {
    capabilities,
    list,
    records,
    selected,
    cache,
    focusRequest,
    runtimeChanged,
    create,
    close,
    newTerminal,
    choose,
    end,
    retryCreate:
      failedIntent?.runtimeId === runtimeId &&
      failedIntent?.expectedWorkspaceId === scope.expectedWorkspaceId
        ? () => void execute(failedIntent)
        : undefined,
  };
}
