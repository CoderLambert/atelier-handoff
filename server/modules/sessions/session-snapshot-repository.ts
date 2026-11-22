/**
 * @file 定义会话快照的持久化读取契约。
 * @implementation 定义完整会话快照及恢复专用读取，后者按会话返回有序运行、消息与工具记录。
 * @updated 2026-11-22T18:15:09+08:00
 */
import type { Tables, RunEvent } from '../../../shared/types.js';
import type { Subagent } from '../../../shared/subagents.js';

export interface SessionSnapshotRecords {
  session: Tables['sessions'];
  project: Tables['projects'];
  runs: Tables['runs'][];
  subagents: Subagent[];
  messages: Tables['messages'][];
  tools: Tables['tools'][];
  permissions: Tables['permissions'][];
  artifacts: Tables['artifacts'][];
  attachments: Tables['attachments'][];
  events: RunEvent[];
  cursor: number;
}

export interface SessionSnapshotRepository {
  read(sessionId: string): SessionSnapshotRecords;
  readRecovery(sessionId: string): Pick<SessionSnapshotRecords, 'runs' | 'messages' | 'tools'>;
}
