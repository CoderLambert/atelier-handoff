/**
 * @file 判断当前运行能否续接已保存的 SDK 对话。
 * @implementation 以宿主确认的托管网关身份计算兼容键，并用消息锚点验证旧键及分叉来源。
 * @updated 2026-11-27T02:58:23+08:00
 */
import { AppError, type Message, type Run, type Session } from '../shared/types.js';
import { fingerprint } from './files.js';
import type { SessionSnapshotRepository } from './modules/sessions/session-snapshot-repository.js';
import type { Store } from './store.js';

type Recovery = ReturnType<SessionSnapshotRepository['readRecovery']>;
type ResumeStore = Pick<Store, 'get' | 'readTransaction' | 'sessionSnapshots'>;
type Compatibility = Pick<Run, 'config' | 'executor' | 'agent'>;

function managedLoopback(run: Compatibility): boolean {
  const port = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(run.config.gateway)?.[1];
  return run.config.managedGateway === true && port !== undefined && Number(port) <= 65535;
}

function compatibilityKey(run: Compatibility, managed = false): string {
  return fingerprint(
    JSON.stringify({
      recoveryIdentity: managed ? 2 : 1,
      gateway: managed ? 'atelier-managed-shunt' : run.config.gateway,
      executor: run.executor === 'native-v1' ? 'native-v1' : 'project-v1',
      ...(run.agent ? { agentRevisionId: run.agent.revisionId } : {}),
    }),
  );
}

function legacyRunMatches(previous: Run | undefined, run: Run, oldKey: string): boolean {
  return (
    previous !== undefined &&
    previous.projectId === run.projectId &&
    previous.status === 'completed' &&
    previous.mode === run.mode &&
    managedLoopback(previous) &&
    compatibilityKey(previous) === oldKey &&
    compatibilityKey(previous, true) === compatibilityKey(run, true)
  );
}

function hasLegacyAnchor(store: ResumeStore, session: Session, run: Run, recovery: Recovery) {
  const key = session.sdkConfigKey;
  if (!key) return false;
  const matchesAnchor = (message: Message) =>
    message.forkAnchor?.sdkSessionId === session.sdkSessionId &&
    message.forkAnchor?.configKey === key;
  const anchor = recovery.messages.findLast(matchesAnchor);
  if (anchor)
    return legacyRunMatches(
      recovery.runs.find(({ id }) => id === anchor.runId),
      run,
      key,
    );
  if (!session.fork) return false;
  // A newly forked transcript has its own SDK ID. Its original message is the durable source
  // of the compatibility key inherited when the fork was created.
  try {
    const source = store.get('messages', session.fork.sourceMessageId);
    if (source.sessionId !== session.fork.sourceSessionId || source.forkAnchor?.configKey !== key)
      return false;
    const previous = store.get('runs', source.runId);
    return previous.sessionId === source.sessionId && legacyRunMatches(previous, run, key);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return false;
    throw error;
  }
}

export function prepareSdkResume(store: ResumeStore, session: Session, run: Run) {
  const managed =
    managedLoopback(run) && run.config.gateway === process.env.ATELIER_MANAGED_GATEWAY;
  const configKey = compatibilityKey(run, managed);
  const canResume = Boolean(session.sdkSessionId) && session.sdkMode === run.mode;
  if (canResume && session.sdkConfigKey === configKey) return { configKey, resumeExisting: true };

  return store.readTransaction(() => {
    const recovery = store.sessionSnapshots.readRecovery(session.id);
    if (managed && canResume && hasLegacyAnchor(store, session, run, recovery))
      return { configKey, resumeExisting: true };
    return { configKey, resumeExisting: false, recovery };
  });
}
