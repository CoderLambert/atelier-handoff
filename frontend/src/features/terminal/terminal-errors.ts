/**
 * @file 将终端协议与运行时错误映射为稳定提示。
 * @implementation 未知错误统一回退，避免向界面泄漏票据、内部路径和传输正文。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { getTranslator } from '@/i18n';
import type { terminal } from '@shared/i18n/catalogs/terminal';
import type { TerminalCapabilities, TerminalState } from '@shared/terminal';
export const terminalStateKeys = {
  creating: 'state.creating',
  'awaiting-attach': 'state.awaitingAttach',
  starting: 'state.starting',
  running: 'state.running',
  exited: 'state.exited',
  closing: 'state.closing',
  'cleanup-failed': 'state.cleanupFailed',
  closed: 'state.closed',
  failed: 'state.failed',
} as const satisfies Record<TerminalState, keyof typeof terminal>;
export const terminalUnavailableKeys = {
  'desktop-required': 'unavailable.desktopRequired',
  'platform-unsupported': 'unavailable.platformUnsupported',
  'native-execution-disabled': 'unavailable.nativeExecutionDisabled',
  'runtime-unavailable': 'unavailable.runtimeUnavailable',
} as const satisfies Record<
  Exclude<TerminalCapabilities['reason'], 'available'>,
  keyof typeof terminal
>;
type ErrorKey = Extract<keyof typeof terminal, `errors.${string}`>;
const errors: Record<string, ErrorKey> = {
  TERMINAL_UNAVAILABLE: 'errors.unavailable',
  TERMINAL_LIMIT: 'errors.limit',
  TERMINAL_RUNTIME_CHANGED: 'errors.changed',
  GIT_WORKTREE_CHANGED: 'errors.changed',
  GIT_WORKTREE_MISSING: 'errors.changed',
  TERMINAL_CLOSED: 'errors.closed',
  TERMINAL_NOT_FOUND: 'errors.closed',
  TERMINAL_ID_CONFLICT: 'errors.conflict',
  TERMINAL_ACTIVE: 'errors.conflict',
  TERMINAL_PROTOCOL: 'errors.protocol',
  TERMINAL_TIMEOUT: 'errors.timeout',
  TERMINAL_SLOW_CONSUMER: 'errors.slow',
  TERMINAL_READY_TIMEOUT: 'errors.timeout',
  TERMINAL_PROTOCOL_ERROR: 'errors.protocol',
  TERMINAL_OUTPUT_LIMIT: 'errors.slow',
  TERMINAL_SNAPSHOT_TOO_LARGE: 'errors.slow',
};
export function terminalErrorMessage(error: unknown): string {
  const code =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
  return getTranslator('terminal')(code ? (errors[code] ?? 'errors.failed') : 'errors.failed');
}
