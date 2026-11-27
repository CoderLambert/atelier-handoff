/**
 * @file 推导桌面浏览器的纯状态文案键、色调与 Agent 标签跳转标记。
 * @implementation 用清晰早返回替代深层嵌套三元表达式，输出受 browser i18n 命名空间约束的词条键与语义色调。
 * @updated 2026-11-27T22:00:00+08:00
 */
import type { DesktopBrowserState } from '@shared/desktop-browser';

export type DesktopBrowserStatusTone = 'error' | 'busy' | 'control' | 'notice' | 'idle';

export type DesktopBrowserStatusKey =
  | 'status.transferring'
  | 'status.connecting'
  | 'status.paused'
  | 'status.readingAccess'
  | 'status.unavailable'
  | 'status.disabled'
  | 'status.noTabs'
  | 'status.otherTab'
  | 'status.busy'
  | 'status.agentTab'
  | 'status.waiting';

export interface DeriveDesktopBrowserStatusInput {
  readonly state: DesktopBrowserState | undefined;
  readonly hasError: boolean;
  readonly transferring: boolean;
  readonly accessPending: boolean;
  readonly agentAvailable: boolean;
  readonly agentEnabled: boolean;
  readonly hasAgentTab: boolean;
  readonly differentAgentTab: boolean;
}

export interface DesktopBrowserStatusDerived {
  readonly tone: DesktopBrowserStatusTone;
  readonly key: DesktopBrowserStatusKey | null;
  readonly showAgentTarget: boolean;
}

function resolveStatusKey(input: DeriveDesktopBrowserStatusInput): DesktopBrowserStatusKey | null {
  if (input.hasError) return null;
  if (input.transferring) return 'status.transferring';
  if (!input.state) return 'status.connecting';
  if (input.state.control) return 'status.paused';
  if (input.accessPending) return 'status.readingAccess';
  if (!input.agentAvailable) return 'status.unavailable';
  if (!input.agentEnabled) return 'status.disabled';
  if (input.state.tabs.length === 0) return 'status.noTabs';
  if (input.differentAgentTab) return 'status.otherTab';
  if (input.state.busy) return 'status.busy';
  if (input.hasAgentTab) return 'status.agentTab';
  return 'status.waiting';
}

function resolveStatusTone(
  input: DeriveDesktopBrowserStatusInput,
  showAgentTarget: boolean,
): DesktopBrowserStatusTone {
  if (input.hasError) return 'error';
  if (input.transferring) return 'busy';
  if (input.state?.control) return 'control';
  if (input.state?.busy) return 'busy';
  if (!input.agentAvailable || !input.agentEnabled || showAgentTarget) return 'notice';
  return 'idle';
}

export function deriveDesktopBrowserStatus(
  input: DeriveDesktopBrowserStatusInput,
): DesktopBrowserStatusDerived {
  const showAgentTarget =
    input.differentAgentTab && !input.state?.control && !input.transferring && !input.hasError;

  return {
    tone: resolveStatusTone(input, showAgentTarget),
    key: resolveStatusKey(input),
    showAgentTarget,
  };
}
