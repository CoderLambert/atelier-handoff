/**
 * @file 保存公开 GitHub 导入的账号连接偏好。
 * @implementation 在既有设置表读取、保存或删除账号名，凭据由 GitHub CLI 保管。
 * @updated 2026-11-26T15:53:01+08:00
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { githubLogin } from '../../../shared/github-public-auth.js';

const settings = sqliteTable('settings', { key: text().primaryKey(), value: text().notNull() });
const key = 'github-public-import-login';
export function githubPublicAuthRepository(db: BetterSQLite3Database) {
  return {
    read() {
      const row = db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .get();
      return githubLogin.safeParse(row?.value).data ?? null;
    },
    save(login: string | null) {
      if (!login) db.delete(settings).where(eq(settings.key, key)).run();
      else {
        const value = githubLogin.parse(login);
        db.insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({ target: settings.key, set: { value } })
          .run();
      }
    },
  };
}
