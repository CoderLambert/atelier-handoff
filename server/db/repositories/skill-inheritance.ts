/**
 * @file 持久化本机 Skill 继承的全局、项目和会话设置。
 * @implementation 复用 settings，以分范围的独立键原子保存设置，批量读取按键范围查询；无效设置不授予权限。
 * @updated 2026-11-25T23:22:56+08:00
 */
import { and, eq, gte, lt } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  SkillInheritanceMode,
  SkillInheritanceOverride,
  SkillInheritanceProjectMode,
} from '../../../shared/skill-inheritance.js';

const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});
const namespace = 'skill-inheritance-v1:';
const globalKey = `${namespace}global`;
const hostPrefix = `${namespace}host:`;
const projectPrefix = `${namespace}project:`;
const sessionPrefix = (sessionId: string) => `${namespace}session:${JSON.stringify(sessionId)}:`;
const settingKey = (prefix: string, id: string) => prefix + JSON.stringify(id);

function parseHostMode(value: string | undefined): SkillInheritanceMode {
  return value === 'manual' || value === 'auto' ? value : 'off';
}

function parseSessionMode(value: string | undefined): SkillInheritanceOverride {
  if (value === undefined || value === 'follow') return 'follow';
  return value === 'manual' ? 'manual' : 'off';
}

export function skillInheritanceRepository(db: BetterSQLite3Database) {
  function readValue(key: string): string | undefined {
    return db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()
      ?.value;
  }

  function saveValue(key: string, value: string): void {
    db.insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }

  function readModes<Mode>(
    prefix: string,
    parse: (value: string) => Mode,
  ): ReadonlyMap<string, Mode> {
    // The binary PK range replaces the final ':' with its successor ';' for the upper bound.
    const end = `${prefix.slice(0, -1)};`;
    const modes = new Map<string, Mode>();
    const rows = db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(and(gte(settings.key, prefix), lt(settings.key, end)))
      .all();
    for (const { key, value } of rows) {
      let id: unknown;
      try {
        id = JSON.parse(key.slice(prefix.length));
      } catch {
        continue;
      }
      if (typeof id === 'string' && settingKey(prefix, id) === key) modes.set(id, parse(value));
    }
    return modes;
  }

  return {
    readGlobal(): boolean {
      return readValue(globalKey) === 'true';
    },
    setGlobal(enabled: boolean): void {
      saveValue(globalKey, enabled === true ? 'true' : 'false');
    },
    hostMode(id: string): SkillInheritanceMode {
      return parseHostMode(readValue(settingKey(hostPrefix, id)));
    },
    setHostMode(id: string, mode: SkillInheritanceMode): void {
      saveValue(settingKey(hostPrefix, id), mode);
    },
    hostModes(): ReadonlyMap<string, SkillInheritanceMode> {
      return readModes(hostPrefix, parseHostMode);
    },
    projectMode(projectId: string): SkillInheritanceProjectMode {
      const value = readValue(settingKey(projectPrefix, projectId));
      return value === undefined || value === 'follow' ? 'follow' : 'block';
    },
    setProjectMode(projectId: string, mode: SkillInheritanceProjectMode): void {
      saveValue(settingKey(projectPrefix, projectId), mode);
    },
    sessionMode(sessionId: string, id: string): SkillInheritanceOverride {
      return parseSessionMode(readValue(settingKey(sessionPrefix(sessionId), id)));
    },
    setSessionMode(sessionId: string, id: string, mode: SkillInheritanceOverride): void {
      saveValue(settingKey(sessionPrefix(sessionId), id), mode);
    },
    sessionModes(sessionId: string): ReadonlyMap<string, SkillInheritanceOverride> {
      return readModes(sessionPrefix(sessionId), parseSessionMode);
    },
  };
}
