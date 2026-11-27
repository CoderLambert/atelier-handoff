/**
 * @file 使用 Drizzle 读写 JSON 文档表。
 * @implementation 统一映射 Store 管理的各业务 JSON 表的 id/data 主列，提供按主键读取、按插入顺序列表、幂等写入和删除操作。
 * @updated 2026-11-27T11:23:00-08:00
 */
import { asc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { AppError, type Table, type Tables } from '../../../shared/types.js';

const documentTable = (name: string) =>
  sqliteTable(name, {
    id: text('id').primaryKey(),
    data: text('data').notNull(),
  });

type DocumentTable = ReturnType<typeof documentTable>;

const documentTables: Record<Table, DocumentTable> = {
  projects: documentTable('projects'),
  sessions: documentTable('sessions'),
  runs: documentTable('runs'),
  messages: documentTable('messages'),
  tools: documentTable('tools'),
  permissions: documentTable('permissions'),
  artifacts: documentTable('artifacts'),
  attachments: documentTable('attachments'),
  extensions: documentTable('extensions'),
  agents: documentTable('agents'),
  agentRevisions: documentTable('agentRevisions'),
};

const insertionOrder = asc(sql.identifier('rowid'));

export function documentTablesRepository(db: BetterSQLite3Database) {
  return {
    get<K extends Table>(table: K, id: string): Tables[K] {
      const target: DocumentTable = documentTables[table];
      const row = db.select({ data: target.data }).from(target).where(eq(target.id, id)).get();
      if (!row) throw new AppError('NOT_FOUND', '记录不存在或已删除。', 404);
      return JSON.parse(row.data) as Tables[K];
    },
    list<K extends Table>(table: K): Tables[K][] {
      const target: DocumentTable = documentTables[table];
      return db
        .select({ data: target.data })
        .from(target)
        .orderBy(insertionOrder)
        .all()
        .map((row) => JSON.parse(row.data) as Tables[K]);
    },
    put<K extends Table>(table: K, value: Tables[K]): Tables[K] {
      const target: DocumentTable = documentTables[table];
      const data = JSON.stringify(value);
      db.insert(target)
        .values({ id: value.id, data })
        .onConflictDoUpdate({ target: target.id, set: { data } })
        .run();
      return value;
    },
    delete(table: Table, id: string): void {
      const target: DocumentTable = documentTables[table];
      db.delete(target).where(eq(target.id, id)).run();
    },
  };
}
