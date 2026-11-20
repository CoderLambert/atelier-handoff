/**
 * @file 使用 Drizzle 按会话读取完整快照所需的数据库记录。
 * @implementation 按主键或会话索引查询，保留历史 rowid 顺序、附件可见规则、事件窗口和全局游标。
 * @updated 2026-11-21T01:00:00+08:00
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AppError } from '../../../shared/types.js';
import type { SessionSnapshotRepository } from '../../modules/sessions/session-snapshot-repository.js';
import { decodePayload, decodeRecord, records } from '../mappers/session-records.js';
import * as schema from '../schema/session-snapshot.js';

const insertionOrder = asc(sql.identifier('rowid'));
const scoped = {
  runs: schema.runs,
  messages: schema.messages,
  tools: schema.tools,
  permissions: schema.permissions,
  artifacts: schema.artifacts,
};

export function sessionSnapshotRepository(db: BetterSQLite3Database): SessionSnapshotRepository {
  return {
    read(id) {
      const sessionRow = db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
      if (!sessionRow) throw new AppError('NOT_FOUND', '记录不存在或已删除。', 404);
      const session = decodeRecord(records.sessions, sessionRow);
      const projectRow = db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, session.projectId))
        .get();
      if (!projectRow) throw new AppError('NOT_FOUND', '记录不存在或已删除。', 404);
      const rows = (table: (typeof scoped)[keyof typeof scoped]) =>
        db
          .select({ id: table.id, data: table.data })
          .from(table)
          .where(eq(table.sessionId, id))
          .orderBy(insertionOrder)
          .all();
      const attachments = schema.attachments;
      const events = schema.events;
      return {
        session,
        project: decodeRecord(records.projects, projectRow),
        runs: rows(scoped.runs).map((row) => decodeRecord(records.runs, row)),
        messages: rows(scoped.messages).map((row) => decodeRecord(records.messages, row)),
        tools: rows(scoped.tools).map((row) => decodeRecord(records.tools, row)),
        permissions: rows(scoped.permissions).map((row) => decodeRecord(records.permissions, row)),
        artifacts: rows(scoped.artifacts).map((row) => decodeRecord(records.artifacts, row)),
        attachments: db
          .select({ id: attachments.id, data: attachments.data })
          .from(attachments)
          .where(and(eq(attachments.sessionId, id), eq(attachments.visible, 1)))
          .orderBy(insertionOrder)
          .all()
          .map((row) => decodeRecord(records.attachments, row)),
        events: db
          .select()
          .from(events)
          .where(eq(events.sessionId, id))
          .orderBy(desc(events.id))
          .limit(500)
          .all()
          .reverse()
          .map((row) => ({ ...row, payload: decodePayload(row.payload) })),
        cursor:
          db.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(1).get()?.id ??
          0,
      };
    },
  };
}
