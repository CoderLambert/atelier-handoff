/**
 * @file 使用 Drizzle 按状态与运行读取热路径记录。
 * @implementation 以 v11 派生列和索引实现活动运行、未结束工具、待审批、运行产物的具名查询，沿用历史 rowid 顺序并经校验映射解码。
 * @updated 2026-11-27T20:10:00+08:00
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  activeStatuses,
  type Artifact,
  type Permission,
  type Run,
  type ToolCall,
} from '../../../shared/types.js';
import { decodeRecord, records } from '../mappers/session-records.js';
import { artifacts, messages, permissions, runs, tools } from '../schema/session-snapshot.js';

const insertionOrder = asc(sql.identifier('rowid'));
const activeToolStatuses = ['running', 'awaiting_permission'] as const;

export function runtimeRecordRepositories(db: BetterSQLite3Database) {
  return {
    runs: {
      listActive(): Run[] {
        return db
          .select({ id: runs.id, data: runs.data })
          .from(runs)
          .where(inArray(runs.status, activeStatuses))
          .orderBy(insertionOrder)
          .all()
          .map((row) => decodeRecord(records.runs, row));
      },
      findActiveBySession(sessionId: string): Run | undefined {
        const row = db
          .select({ id: runs.id, data: runs.data })
          .from(runs)
          .where(and(eq(runs.sessionId, sessionId), inArray(runs.status, activeStatuses)))
          .orderBy(insertionOrder)
          .limit(1)
          .get();
        return row ? decodeRecord(records.runs, row) : undefined;
      },
      hasActiveBySession(sessionId: string): boolean {
        return Boolean(
          db
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.sessionId, sessionId), inArray(runs.status, activeStatuses)))
            .limit(1)
            .get(),
        );
      },
    },
    tools: {
      listActive(): ToolCall[] {
        return db
          .select({ id: tools.id, data: tools.data })
          .from(tools)
          .where(inArray(tools.status, activeToolStatuses))
          .orderBy(insertionOrder)
          .all()
          .map((row) => decodeRecord(records.tools, row));
      },
      listByRun(runId: string): ToolCall[] {
        return db
          .select({ id: tools.id, data: tools.data })
          .from(tools)
          .where(eq(tools.runId, runId))
          .orderBy(insertionOrder)
          .all()
          .map((row) => decodeRecord(records.tools, row));
      },
      listActiveByRun(runId: string): ToolCall[] {
        return db
          .select({ id: tools.id, data: tools.data })
          .from(tools)
          .where(and(eq(tools.runId, runId), inArray(tools.status, activeToolStatuses)))
          .orderBy(insertionOrder)
          .all()
          .map((row) => decodeRecord(records.tools, row));
      },
    },
    permissions: {
      listPending(): Permission[] {
        return db
          .select({ id: permissions.id, data: permissions.data })
          .from(permissions)
          .where(eq(permissions.status, 'pending'))
          .orderBy(insertionOrder)
          .all()
          .map((row) => decodeRecord(records.permissions, row));
      },
      listByRun(runId: string): Permission[] {
        return db
          .select({ id: permissions.id, data: permissions.data })
          .from(permissions)
          .where(eq(permissions.runId, runId))
          .orderBy(insertionOrder)
          .all()
          .map((row) => decodeRecord(records.permissions, row));
      },
      listPendingByRun(runId: string): Permission[] {
        return db
          .select({ id: permissions.id, data: permissions.data })
          .from(permissions)
          .where(and(eq(permissions.runId, runId), eq(permissions.status, 'pending')))
          .orderBy(insertionOrder)
          .all()
          .map((row) => decodeRecord(records.permissions, row));
      },
      hasPendingByRun(runId: string): boolean {
        return Boolean(
          db
            .select({ id: permissions.id })
            .from(permissions)
            .where(and(eq(permissions.runId, runId), eq(permissions.status, 'pending')))
            .limit(1)
            .get(),
        );
      },
    },
    artifacts: {
      listByRun(runId: string): Artifact[] {
        return db
          .select({ id: artifacts.id, data: artifacts.data })
          .from(artifacts)
          .where(eq(artifacts.runId, runId))
          .orderBy(insertionOrder)
          .all()
          .map((row) => decodeRecord(records.artifacts, row));
      },
    },
    messages: {
      existsInRun(id: string, runId: string): boolean {
        const row = db
          .select({ id: messages.id, data: messages.data })
          .from(messages)
          .where(eq(messages.id, id))
          .get();
        return row ? decodeRecord(records.messages, row).runId === runId : false;
      },
    },
  };
}
