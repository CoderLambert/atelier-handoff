/**
 * @file 定义会话快照的持久化读取契约。
 * @implementation 返回同一会话的有序记录、最近事件和全局游标，供会话用例补充智能体与队列状态。
 * @updated 2026-11-21T01:00:00+08:00
 */
import type { Tables, RunEvent } from '../../../shared/types.js';

export interface SessionSnapshotRecords {
  session: Tables['sessions'];
  project: Tables['projects'];
  runs: Tables['runs'][];
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
}
