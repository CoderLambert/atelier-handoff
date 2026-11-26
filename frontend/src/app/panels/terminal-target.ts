/**
 * @file 从会话快照确定终端启动目标。
 * @implementation 校验快照归属及目录可用性，目录身份沿用服务端工作区记录。
 * @updated 2026-11-26T01:00:00+08:00
 */
import type { Snapshot } from '@/api/types';

type TerminalSnapshot = {
  session: Pick<Snapshot['session'], 'id' | 'status'>;
  project: Pick<Snapshot['project'], 'available'>;
  workspace?: Pick<NonNullable<Snapshot['workspace']>, 'id' | 'mode' | 'state'>;
};

export function terminalWorkspaceTarget(
  sessionId: string | undefined,
  snapshot?: TerminalSnapshot,
) {
  return {
    expectedWorkspaceId: snapshot?.workspace?.id ?? null,
    canCreate: Boolean(
      snapshot &&
      snapshot.session.id === sessionId &&
      snapshot.session.status !== 'archived' &&
      snapshot.project.available &&
      (!snapshot.workspace || snapshot.workspace.state === 'ready'),
    ),
  };
}
