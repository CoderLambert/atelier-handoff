/**
 * @file 校验会话能否选择本机信任执行。
 * @implementation 要求配对桌面能力、未绑定智能体的修改会话及独立的权限模式。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { AppError, type Run, type Session } from '../../../shared/types.js';

export function assertNativeExecution(
  available: boolean,
  session: Session,
  mode: Run['mode'],
  approvalMode?: 'automatic',
): void {
  if (!available)
    throw new AppError(
      'NATIVE_EXECUTION_UNAVAILABLE',
      '本机信任仅在已配对的 Linux 桌面可用。',
      403,
    );
  if (session.agentRevisionId)
    throw new AppError('AGENT_MODE_DENIED', '绑定智能体须保留其工具与权限范围。', 403);
  if (mode !== 'edit' || approvalMode)
    throw new AppError(
      'NATIVE_EXECUTION_INVALID',
      '本机信任须单独选择，不能与只读或自动审批组合。',
    );
}
