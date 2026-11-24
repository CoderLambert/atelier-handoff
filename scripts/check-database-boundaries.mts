/**
 * @file 检查运行时代码中的 SQL 和 ORM 导入边界。
 * @implementation 用语法树定位数据库访问，按路径、指纹和次数核对遗留调用与单独登记的例外，检查例外关联的决策和测试文件，并报告失效条目。
 * @updated 2026-11-21T00:51:43+08:00
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, posix } from 'node:path';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { z } from 'zod';

const rawStatement =
  /^\s*(?:select\s+[\s\S]+?\sfrom\s|insert\s+(?:or\s+\w+\s+)?into\s|update\s+[\w$"`[.]+\s+set\s|delete\s+from\s|(?:create|alter|drop)\s+(?:unique\s+)?(?:table|index|trigger|view)\s|pragma\s|begin\s+(?:immediate|exclusive|deferred)\b|(?:rollback|commit)\s+(?:transaction|work)\b)/i;
const transactionStatement = /^\s*(?:begin|commit|rollback)\s*;?\s*$/i;
const drivers = /^(?:node:sqlite|better-sqlite3)(?:\/|$)/;
const orm = /^drizzle-orm(?:\/|$)/;
export type DatabaseSite = { key: string; line: number };

export function databaseSites(file: string, text: string): DatabaseSite[] {
  const tree = parse(text, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const sites: DatabaseSite[] = [];
  const sqlNames = new Set(['sql']);
  const allowedOrm =
    /^server\/db\/(?:connection\.ts$|unit-of-work\.ts$|(?:schema|repositories|mappers|maintenance|migrations)\/)/.test(
      file,
    );
  const driverOwner =
    file === 'server/db/connection.ts' || file.startsWith('server/db/maintenance/');
  const add = (
    node: t.Node,
    kind: string,
    identity = text.slice(node.start ?? 0, node.end ?? 0),
  ) => {
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16);
    sites.push({ key: `${kind}:${hash}`, line: node.loc?.start.line ?? 1 });
  };
  for (const decl of tree.program.body) {
    if (!t.isImportDeclaration(decl) || !orm.test(decl.source.value)) continue;
    for (const spec of decl.specifiers) {
      if (t.isImportSpecifier(spec) && t.isIdentifier(spec.imported, { name: 'sql' }))
        sqlNames.add(spec.local.name);
    }
  }
  t.traverseFast(tree, (node) => {
    if (t.isStringLiteral(node)) {
      if (drivers.test(node.value) && !driverOwner) add(node, 'driver', node.value);
      if (orm.test(node.value) && !allowedOrm) add(node, 'orm-import', node.value);
      if (
        node.value.startsWith('.') &&
        !allowedOrm &&
        !['server/main.ts', 'server/app.ts'].includes(file)
      ) {
        const target = posix.normalize(posix.join(posix.dirname(file), node.value));
        const storeConnection = file === 'server/store.ts' && target === 'server/db/connection.js';
        if (target.startsWith('server/db/') && !storeConnection)
          add(node, 'persistence-import', node.value);
      }
    }
    const value = t.isStringLiteral(node)
      ? node.value
      : t.isTemplateLiteral(node)
        ? node.quasis[0]?.value.raw
        : undefined;
    if (value && rawStatement.test(value)) add(node, 'sql');
    if (t.isTaggedTemplateExpression(node)) {
      const tag = node.tag;
      if (
        t.isIdentifier(tag)
          ? sqlNames.has(tag.name)
          : t.isMemberExpression(tag) && t.isIdentifier(tag.property, { name: 'sql' })
      )
        add(node, 'sql-template');
    }
    if (
      t.isMemberExpression(node) &&
      t.isIdentifier(node.property, { name: '$client' }) &&
      !driverOwner
    )
      add(node, 'driver-client');
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee)) {
      const access = node.callee;
      if (
        t.isIdentifier(access.property, { name: 'raw' }) &&
        t.isIdentifier(access.object) &&
        sqlNames.has(access.object.name)
      )
        add(node, 'sql-raw');
      const target = access.object;
      const driverCall =
        (t.isIdentifier(target) && /^(?:db|sqlite|driver|lease|client)$/i.test(target.name)) ||
        (t.isMemberExpression(target) && t.isIdentifier(target.property, { name: 'db' }));
      if (
        driverCall &&
        t.isIdentifier(access.property) &&
        ['exec', 'prepare'].includes(access.property.name)
      ) {
        const arg = node.arguments[0];
        const literal = t.isStringLiteral(arg)
          ? arg.value
          : t.isTemplateLiteral(arg)
            ? arg.quasis[0]?.value.raw
            : undefined;
        if (literal && transactionStatement.test(literal) && arg) add(arg, 'sql');
        else if (!literal || !rawStatement.test(literal)) add(node, 'driver-call');
      }
    }
  });
  return sites;
}

export function unexpectedSites(
  sites: DatabaseSite[],
  baseline: readonly string[],
): DatabaseSite[] {
  const remaining = [...baseline];
  return sites.filter((site) => {
    const match = remaining.indexOf(site.key);
    if (match < 0) return true;
    remaining.splice(match, 1);
    return false;
  });
}

export async function checkDatabaseBoundaries(root: string) {
  const baseline = z
    .record(z.string(), z.array(z.string()))
    .parse(JSON.parse(await readFile(join(root, 'scripts/database-legacy.json'), 'utf8')));
  // New exceptions live separately from the shrinking legacy inventory.
  const exceptions = z
    .array(
      z.strictObject({
        file: z
          .string()
          .regex(/^server\/db\/(?:repositories|maintenance|migrations)\/[\w/-]+\.ts$/),
        key: z.string().regex(/^(?:sql|sql-template|driver-call):[0-9a-f]{16}$/),
        decision: z.string().regex(/^docs\/decisions\/[\w-]+\.md$/),
        test: z.string().regex(/^tests\/[\w/-]+\.test\.ts$/),
      }),
    )
    .parse(JSON.parse(await readFile(join(root, 'scripts/database-exceptions.json'), 'utf8')));
  for (const item of exceptions) {
    await Promise.all([readFile(join(root, item.decision)), readFile(join(root, item.test))]);
    (baseline[item.file] ??= []).push(item.key);
  }
  const visited = new Set<string>();
  const errors: string[] = [];
  for (const directory of [
    'server',
    'shared',
    'desktop',
    'frontend/src',
    'packages/markdown/src',
  ]) {
    for (const entry of await readdir(join(root, directory), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (
        !entry.isFile() ||
        !/\.[mc]?tsx?$/.test(entry.name) ||
        /\.test\.[mc]?tsx?$/.test(entry.name)
      )
        continue;
      const path = join(entry.parentPath, entry.name);
      const file = relative(root, path).split('\\').join('/');
      visited.add(file);
      const sites = databaseSites(file, await readFile(path, 'utf8'));
      for (const site of unexpectedSites(sites, baseline[file] ?? []))
        errors.push(
          `${file}:${site.line} ${site.key} — 请使用类型化仓储，SQLite 特例按 database.md 单独审查。`,
        );
      // Removing a grandfathered query must also retire its allowance.
      if (
        unexpectedSites(
          (baseline[file] ?? []).map((key) => ({ key, line: 0 })),
          sites.map((site) => site.key),
        ).length
      )
        errors.push(`${file} — 删除已迁移的历史数据库调用指纹。`);
    }
  }
  for (const file of Object.keys(baseline)) {
    if (!visited.has(file)) errors.push(`${file} — 请移除已删除文件的数据库调用指纹。`);
  }
  return errors;
}
