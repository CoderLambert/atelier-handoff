/**
 * @file 检查桌面宿主、运行时及共享契约的静态模块边界。
 * @implementation 解析导入与重导出，报告宿主循环和 HTTP/领域反向依赖，并限制运行时入口与路由文件的行数。
 * @updated 2026-11-27T00:10:00+08:00
 */
import { readdir, readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { z } from 'zod';

const sourceDirs = [
  'desktop',
  'server',
  'shared',
  'frontend/src',
  'scripts',
  'packages/markdown/src',
  'packages/markdown/scripts',
];
const configSchema = z.object({
  compilerOptions: z.object({
    paths: z.record(z.string(), z.array(z.string())).default({}),
  }),
});
const inDirectory = (file: string, directory: string) => file.startsWith(`${directory}/`);
const isFrontend = (file: string) =>
  inDirectory(file, 'frontend/src') || inDirectory(file, 'packages/markdown/src');
const isHost = (file: string) => inDirectory(file, 'desktop/host');
const isTest = (file: string) => /\.(?:test|spec)\.[cm]?tsx?$/.test(file);
const runtimeModule = (specifier: string) =>
  specifier.startsWith('node:') ||
  isBuiltin(specifier) ||
  /^(?:electron|@electron\/remote)(?:\/|$)/.test(specifier);

function literal(node: t.Node | null | undefined): string | undefined {
  if (t.isStringLiteral(node)) return node.value;
  if (t.isTemplateLiteral(node) && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function imports(source: string, filename: string): { specifier: string; line: number }[] {
  const tree = parse(source, {
    sourceFilename: filename,
    sourceType: 'unambiguous',
    createImportExpressions: true,
    plugins: filename.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
  });
  const references: { specifier: string; line: number }[] = [];
  t.traverseFast(tree, (node) => {
    let argument: t.Node | null | undefined;
    if (
      t.isImportDeclaration(node) ||
      t.isExportAllDeclaration(node) ||
      t.isExportNamedDeclaration(node)
    )
      argument = node.source;
    else if (t.isImportExpression(node)) argument = node.source;
    else if (t.isTSImportType(node)) argument = node.argument;
    else if (t.isTSExternalModuleReference(node)) argument = node.expression;
    else if (
      t.isCallExpression(node) &&
      (t.isIdentifier(node.callee, { name: 'require' }) ||
        (t.isMemberExpression(node.callee) &&
          t.isIdentifier(node.callee.object, { name: 'require' }) &&
          t.isIdentifier(node.callee.property, { name: 'resolve' })))
    )
      argument = node.arguments[0];
    const specifier = literal(argument);
    if (specifier !== undefined) references.push({ specifier, line: node.loc?.start.line ?? 1 });
  });
  return references;
}

/** Local architectural enforcement only: does not inspect installed packages or execute imports. */
export async function checkImportBoundaries(root: string): Promise<string[]> {
  const files = new Map<string, string>();
  for (const directory of sourceDirs) {
    const entries = await readdir(resolve(root, directory), {
      withFileTypes: true,
      recursive: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.[cm]?tsx?$/.test(entry.name)) continue;
      const path = resolve(entry.parentPath, entry.name);
      files.set(path, relative(root, path).split('\\').join('/'));
    }
  }
  // Match the aliases used by the renderer's tsconfig and Vite; do not invent aliases for other layers.
  const configPath = resolve(root, 'frontend/tsconfig.json');
  const config = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  const aliases = Object.entries(config.compilerOptions.paths).sort(
    ([left], [right]) =>
      Number(left.includes('*')) - Number(right.includes('*')) ||
      right.indexOf('*') - left.indexOf('*') ||
      right.length - left.length,
  );
  function modulePath(specifier: string, importer: string): string | undefined {
    const name = specifier.replace(/[?#].*$/, '');
    let bases: string[] = [];
    if (name.startsWith('.')) bases = [resolve(dirname(importer), name)];
    else if (name.startsWith('file:')) bases = [fileURLToPath(name)];
    else if (isAbsolute(name)) bases = [resolve(root, `.${name}`), name];
    else if (isFrontend(files.get(importer) ?? '')) {
      for (const [pattern, targets] of aliases) {
        const star = pattern.indexOf('*');
        const prefix = star < 0 ? pattern : pattern.slice(0, star);
        const suffix = star < 0 ? '' : pattern.slice(star + 1);
        if (star < 0 ? name !== pattern : !name.startsWith(prefix) || !name.endsWith(suffix))
          continue;
        const match = star < 0 ? '' : name.slice(prefix.length, name.length - suffix.length);
        bases = targets.map((target) => resolve(dirname(configPath), target.replace('*', match)));
        break;
      }
    }
    for (const base of bases) {
      const candidates = /\.mjs$/.test(base)
        ? [base.replace(/\.mjs$/, '.mts'), base.replace(/\.mjs$/, '.d.mts')]
        : /\.cjs$/.test(base)
          ? [base.replace(/\.cjs$/, '.cts'), base.replace(/\.cjs$/, '.d.cts')]
          : /\.jsx?$/.test(base)
            ? ['.ts', '.tsx', '.d.ts'].map((extension) => base.replace(/\.jsx?$/, extension))
            : [
                base,
                ...['.ts', '.tsx', '.mts', '.cts'].flatMap((ext) => [
                  base + ext,
                  `${base}/index${ext}`,
                ]),
              ];
      for (const candidate of candidates) {
        const file = files.get(candidate);
        if (file) return file;
      }
    }
    // Still catch an obvious forbidden edge if its target has not been authored yet.
    for (const base of bases) {
      const file = relative(root, base).split('\\').join('/');
      if (/^(?:desktop|server|shared|frontend|packages\/markdown)\//.test(file)) return file;
    }
    return undefined;
  }

  const errors: string[] = [];
  const graph = new Map<string, Set<string>>();
  for (const [path, file] of files) {
    if (isHost(file)) graph.set(file, new Set());
    const source = await readFile(path, 'utf8');
    const limit =
      file === 'server/app.ts' ? 300 : inDirectory(file, 'server/http') ? 350 : undefined;
    if (limit !== undefined) {
      const lines = source.replace(/\r?\n$/, '').split(/\r?\n/).length;
      if (lines > limit) errors.push(`${file}: ${lines} lines exceeds the ${limit}-line boundary.`);
    }
    for (const { specifier, line } of imports(source, file)) {
      const target = modulePath(specifier, path);
      const location = `${file}:${line}: ${JSON.stringify(specifier)}`;
      const domain = inDirectory(file, 'server/modules');
      if (target && domain && inDirectory(target, 'server/http'))
        errors.push(`${location}: server domain modules cannot import HTTP adapters.`);
      if (
        target &&
        (domain || inDirectory(file, 'server/http')) &&
        (/^server\/(?:app|main)\.[cm]?[jt]s$/.test(target) || inDirectory(target, 'server/runtime'))
      )
        errors.push(`${location}: HTTP and domain modules cannot import runtime composition.`);
      if (
        (isFrontend(file) || inDirectory(file, 'shared')) &&
        !isTest(file) &&
        runtimeModule(specifier.replace(/[?#].*$/, ''))
      )
        errors.push(`${location}: frontend/shared cannot import Node or Electron runtime modules.`);
      if (
        isFrontend(file) &&
        target &&
        (inDirectory(target, 'desktop') || inDirectory(target, 'server'))
      )
        errors.push(
          `${location}: frontend cannot import desktop/server implementations; use shared contracts.`,
        );
      if (
        inDirectory(file, 'shared') &&
        target &&
        (isFrontend(target) || inDirectory(target, 'desktop') || inDirectory(target, 'server'))
      )
        errors.push(`${location}: shared cannot import application implementations.`);
      if (
        inDirectory(file, 'desktop') &&
        target &&
        (inDirectory(target, 'server') || isFrontend(target))
      )
        errors.push(
          `${location}: desktop cannot import runtime/frontend implementations; use shared contracts.`,
        );
      if (target && isHost(target) && !isHost(file) && file !== 'desktop/main.mts')
        errors.push(
          `${location}: private desktop/host modules are only exposed to desktop/main.mts.`,
        );
      if (isHost(file) && target && isHost(target)) graph.get(file)?.add(target);
    }
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  function visit(file: string): void {
    if (active.has(file)) {
      errors.push(
        `desktop/host dependency cycle: ${[...stack.slice(stack.indexOf(file)), file].join(' -> ')}`,
      );
      return;
    }
    if (visited.has(file)) return;
    active.add(file);
    stack.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    stack.pop();
    active.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return errors;
}
