/**
 * @file 组合会话快照和会话级操作状态。
 * @implementation 在同一读取事务内装配有序记录、智能体升级资格与活动运行对应的队列动作。
 * @updated 2026-11-21T01:00:00+08:00
 */
import type {
  AgentCard,
  AgentSessionInfo,
  Run,
  SessionMessageQueue,
} from '../../../shared/types.js';
import type { SessionSnapshotRepository } from './session-snapshot-repository.js';

interface SnapshotDependencies {
  repository: SessionSnapshotRepository;
  readTransaction<T>(work: () => T): T;
  boundAgent(projectId: string, revisionId: string): AgentSessionInfo;
  latestAgent(projectId: string, agentId: string): Pick<AgentCard, 'revisionId' | 'issues'>;
  queue(sessionId: string, active: Run | undefined): SessionMessageQueue;
}

export function createGetSessionSnapshot(dependencies: SnapshotDependencies) {
  return (sessionId: string) =>
    dependencies.readTransaction(() => {
      const records = dependencies.repository.read(sessionId);
      const {
        session: { inheritedMessages, creatingFork: _creating, ...session },
        runs,
        messages,
      } = records;
      const agent = session.agentRevisionId
        ? dependencies.boundAgent(session.projectId, session.agentRevisionId)
        : undefined;
      const latest =
        agent?.issues.length && session.status === 'active' && !runs.length && !messages.length
          ? dependencies.latestAgent(session.projectId, agent.id)
          : undefined;
      const active = runs.find(
        (run) => run.status === 'running' || run.status === 'awaiting_permission',
      );
      return {
        ...records,
        session,
        ...(inheritedMessages ? { inheritedMessages } : {}),
        ...(agent
          ? {
              agent: {
                ...agent,
                canUpgrade:
                  !!latest && latest.revisionId !== agent.revisionId && !latest.issues.length,
              },
            }
          : {}),
        messageQueue: dependencies.queue(session.id, active),
      };
    });
}
