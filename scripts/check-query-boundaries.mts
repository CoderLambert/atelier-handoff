/**
 * @file 检查前端数据请求与查询层边界。
 * @implementation 解析源码识别请求及查询调用，对照遗留清单检查新增调用。
 * @updated 2026-11-20T02:00+08:00
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { z } from 'zod';

const root = fileURLToPath(new URL('../frontend/src/', import.meta.url));
const budget = z.record(z.string(), z.array(z.string()));
const oldSites: Record<string, string[]> = {};
const errors: string[] = [];
const queryMethods = new Set([
  'useQuery',
  'useQueries',
  'useSuspenseQuery',
  'useSuspenseQueries',
  'useInfiniteQuery',
  'useMutation',
  'queryOptions',
  'infiniteQueryOptions',
  'mutationOptions',
  'useQueryClient',
]);
const trackedMethod = (module: string, name: string) =>
  (module === '@tanstack/react-query' && queryMethods.has(name)) ||
  (module.endsWith('/api/client') && ['api', 'bootstrap'].includes(name)) ||
  name === 'useResource';

for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
  const path = join(entry.parentPath, entry.name);
  const file = relative(root, path).split('\\').join('/');
  if (file === 'api/client.ts') continue;
  const source = await readFile(path, 'utf8');
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const hooks = new Map<string, string>();
  const namespaces = new Map<string, string>();
  for (const node of tree.program.body) {
    if (!t.isImportDeclaration(node) || node.importKind === 'type') continue;
    for (const spec of node.specifiers) {
      if (t.isImportNamespaceSpecifier(spec)) namespaces.set(spec.local.name, node.source.value);
      if (!t.isImportSpecifier(spec) || spec.importKind === 'type') continue;
      const name = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
      if (trackedMethod(node.source.value, name)) hooks.set(spec.local.name, name);
    }
  }
  let requests = 0;
  const inQuery = file.startsWith('use-query/');
  t.traverseFast(tree, (node) => {
    if (!t.isCallExpression(node)) return;
    const fn = node.callee;
    let operation: string | undefined;
    if (t.isIdentifier(fn)) operation = fn.name === 'fetch' ? 'fetch' : hooks.get(fn.name);
    if (t.isMemberExpression(fn) && t.isIdentifier(fn.object) && t.isIdentifier(fn.property)) {
      const mod = namespaces.get(fn.object.name);
      if (mod && trackedMethod(mod, fn.property.name)) operation = fn.property.name;
      if (['window', 'globalThis'].includes(fn.object.name) && fn.property.name === 'fetch')
        operation = 'fetch';
    }
    if (!operation) return;
    if (operation === 'api' || operation === 'fetch') requests++;
    if (inQuery) return;
    // Pin exact existing calls, including arguments. Adding a request in a legacy component must fail too.
    const hash = createHash('sha256')
      .update(source.slice(node.start ?? 0, node.end ?? 0))
      .digest('hex')
      .slice(0, 16);
    (oldSites[file] ??= []).push(`${operation}:${hash}`);
  });
  if (inQuery && requests) {
    if (!/^use-query\/[\w-]+\/use-[\w-]+\.ts$/.test(file) || requests > 1)
      errors.push(`${file}: 每个 API 操作应有独立的 use-query/<领域>/use-*.ts 文件。`);
  }
}

const sorted = Object.fromEntries(
  Object.entries(oldSites)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, sites]) => [file, sites.sort()]),
);
if (process.argv.includes('--inventory')) {
  console.log(JSON.stringify(sorted, null, 2));
} else {
  const legacy = budget.parse(
    JSON.parse(await readFile(new URL('./query-legacy.json', import.meta.url), 'utf8')),
  );
  for (const [file, sites] of Object.entries(oldSites)) {
    const allowed = [...(legacy[file] ?? [])];
    for (const site of sites) {
      const index = allowed.indexOf(site);
      if (index >= 0) allowed.splice(index, 1);
      else
        errors.push(
          `${file}: ${site.split(':')[0]} 应移入 frontend/src/use-query/<领域>/，业务编排放入功能 hook。`,
        );
    }
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    `Query boundaries checked; ${Object.keys(oldSites).length} legacy files tracked for migration.`,
  );
}
