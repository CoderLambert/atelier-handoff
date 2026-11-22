/**
 * @file 检查界面文案入口与双语词条。
 * @implementation 解析生产源码定位可显示字面量，校验语义键、插值和复数分支。
 * @updated 2026-11-22T15:00:00+08:00
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import * as ast from '@babel/types';
import { z } from 'zod';

const sourceRoots = ['frontend/src', 'desktop', 'packages/markdown/src'];
const presentationProps = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-roledescription',
  'aria-valuetext',
  'caption',
  'description',
  'emptyMessage',
  'label',
  'placeholder',
  'title',
]);
const presentationCalls = new Set([
  'alert',
  'confirm',
  'setNotice',
  'setManagementError',
  'setToast',
]);
const nativeFields = new Set(['title', 'message', 'detail', 'buttonLabel', 'buttons', 'label']);
const nativeCalls = new Set([
  'showOpenDialog',
  'showSaveDialog',
  'showMessageBox',
  'showErrorBox',
  'buildFromTemplate',
]);
const visibleLanguage = /\p{L}/u;

export interface I18nFinding {
  line: number;
  sink: string;
  text: string;
  fingerprint: string;
}

function fingerprint(sink: string, text: string): string {
  return createHash('sha256').update(`${sink}\0${text}`).digest('hex').slice(0, 20);
}

function objectKey(node: ast.Node): string | undefined {
  return ast.isIdentifier(node) ? node.name : ast.isStringLiteral(node) ? node.value : undefined;
}

export function scanI18nSource(source: string, jsx: boolean): I18nFinding[] {
  const root = parse(source, {
    sourceType: 'module',
    plugins: jsx ? ['typescript', 'jsx'] : ['typescript'],
  });
  const findings: I18nFinding[] = [];
  const scopes = new Map<ast.Node, Map<string, ast.Node | null>>();
  const isScope = (node: ast.Node) =>
    ast.isProgram(node) || ast.isBlockStatement(node) || ast.isFunction(node);
  ast.traverse(root, (node, ancestors) => {
    const scope = ancestors.findLast((ancestor) => isScope(ancestor.node))?.node;
    if (!scope) return;
    if (ast.isVariableDeclaration(node)) {
      const bindings = scopes.get(scope) ?? new Map<string, ast.Node | null>();
      for (const { id, init } of node.declarations) {
        if (ast.isIdentifier(id))
          bindings.set(id.name, node.kind === 'const' ? (init ?? null) : null);
      }
      scopes.set(scope, bindings);
    }
    if (ast.isFunction(node)) {
      const bindings = scopes.get(node) ?? new Map<string, ast.Node | null>();
      for (const parameter of node.params) {
        for (const name of Object.keys(ast.getBindingIdentifiers(parameter)))
          bindings.set(name, null);
      }
      scopes.set(node, bindings);
    }
  });
  let enclosingScopes: ast.Node[] = [];
  const resolving = new Set<ast.Node>();
  function record(node: ast.Node, sink: string, raw: string) {
    const text = raw.trim().replace(/\s+/gu, ' ');
    if (!visibleLanguage.test(text)) return;
    findings.push({
      line: node.loc?.start.line ?? 1,
      sink,
      text,
      fingerprint: fingerprint(sink, text),
    });
  }
  function expression(node: ast.Node | null | undefined, sink: string): void {
    if (ast.isStringLiteral(node) || ast.isJSXText(node)) record(node, sink, node.value);
    else if (ast.isIdentifier(node)) {
      const scope = enclosingScopes.findLast((entry) => scopes.get(entry)?.has(node.name));
      if (!scope) return;
      const init = scopes.get(scope)?.get(node.name);
      if (!init || resolving.has(init)) return;
      const previous = enclosingScopes;
      enclosingScopes = previous.slice(0, previous.lastIndexOf(scope) + 1);
      resolving.add(init);
      expression(init, sink);
      resolving.delete(init);
      enclosingScopes = previous;
    } else if (ast.isTemplateLiteral(node)) {
      for (const part of node.quasis) record(part, sink, part.value.cooked ?? part.value.raw);
    } else if (ast.isJSXExpressionContainer(node)) expression(node.expression, sink);
    else if (ast.isConditionalExpression(node)) {
      expression(node.consequent, sink);
      expression(node.alternate, sink);
    } else if (ast.isLogicalExpression(node)) {
      if (node.operator !== '&&') expression(node.left, sink);
      expression(node.right, sink);
    } else if (ast.isBinaryExpression(node, { operator: '+' })) {
      expression(node.left, sink);
      expression(node.right, sink);
    } else if (ast.isArrayExpression(node)) {
      for (const item of node.elements) expression(item, sink);
    } else if (ast.isTSAsExpression(node) || ast.isTSSatisfiesExpression(node)) {
      expression(node.expression, sink);
    }
  }

  function nativeOptions(node: ast.Node) {
    if (ast.isObjectExpression(node)) {
      for (const property of node.properties) {
        if (!ast.isObjectProperty(property)) continue;
        const name = objectKey(property.key);
        if (name && nativeFields.has(name)) expression(property.value, `native:${name}`);
        else if (name === 'filters' && ast.isArrayExpression(property.value)) {
          for (const item of property.value.elements) {
            if (!ast.isObjectExpression(item)) continue;
            for (const field of item.properties) {
              if (ast.isObjectProperty(field) && objectKey(field.key) === 'name') {
                expression(field.value, 'native:filter');
              }
            }
          }
        } else if (name === 'submenu') nativeOptions(property.value);
      }
    } else if (ast.isArrayExpression(node)) {
      for (const item of node.elements) if (item) nativeOptions(item);
    }
  }

  ast.traverse(root, (node, ancestors) => {
    enclosingScopes = ancestors.map(({ node: ancestor }) => ancestor).filter(isScope);
    if (ast.isJSXText(node)) expression(node, 'JSX text');
    else if (ast.isJSXExpressionContainer(node)) {
      const parent = ancestors.at(-1)?.node;
      if (ast.isJSXElement(parent) || ast.isJSXFragment(parent)) expression(node, 'JSX child');
    } else if (ast.isJSXAttribute(node) && ast.isJSXIdentifier(node.name)) {
      if (presentationProps.has(node.name.name)) expression(node.value, `JSX:${node.name.name}`);
    } else if (ast.isObjectProperty(node) && jsx) {
      const name = objectKey(node.key);
      if (name && presentationProps.has(name)) expression(node.value, `option:${name}`);
    } else if (ast.isCallExpression(node)) {
      const callee = node.callee;
      const name = ast.isMemberExpression(callee) ? objectKey(callee.property) : objectKey(callee);
      if (!name) return;
      if (presentationCalls.has(name)) expression(node.arguments[0], `call:${name}`);
      if (nativeCalls.has(name)) {
        for (const argument of node.arguments) {
          if (name === 'showErrorBox') expression(argument, 'native:errorBox');
          else nativeOptions(argument);
        }
      }
    }
  });
  return findings;
}

const messageKey = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*(?:_(?:zero|one|two|few|many|other))?$/u;
const pluralSuffix = /_(zero|one|two|few|many|other)$/u;
const placeholders = (value: string): string[] =>
  [
    ...new Set(
      Array.from(value.matchAll(/\{\{\s*([\w.]+)(?:,[^{}]*)?\s*\}\}/gu), (match) => match[1]),
    ),
  ]
    .filter((name): name is string => name !== undefined)
    .sort();

export function checkCatalog(
  catalog: Readonly<Record<string, readonly [string, string]>>,
): string[] {
  const errors: string[] = [];
  const groups = new Set<string>();
  for (const [key, pair] of Object.entries(catalog)) {
    if (!messageKey.test(key)) errors.push(`${key}: invalid semantic key`);
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some((value) => typeof value !== 'string' || !value.trim())
    ) {
      errors.push(`${key}: both languages must have a non-empty translation`);
      continue;
    }
    if (placeholders(pair[0]).join() !== placeholders(pair[1]).join()) {
      errors.push(`${key}: interpolation variables differ`);
    }
    if (pluralSuffix.test(key)) groups.add(key.replace(pluralSuffix, ''));
  }
  for (const key of groups) {
    const categories = new Set(
      ['en', 'zh-CN'].flatMap(
        (locale) => new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
      ),
    );
    for (const form of categories) {
      if (!Object.hasOwn(catalog, `${key}_${form}`))
        errors.push(`${key}: missing ${form} plural branch`);
    }
  }
  return errors;
}

const exceptionSchema = z.array(
  z.strictObject({
    file: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f\d]{20}$/u),
    reason: z.string().min(10),
  }),
);

async function main() {
  const { catalogs } = await import('../shared/i18n/index.js');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const problems = Object.entries(catalogs).flatMap(([namespace, catalog]) =>
    checkCatalog(catalog).map((error) => `shared/i18n/catalogs/${namespace}.ts: ${error}`),
  );
  const exceptions = exceptionSchema.parse(
    JSON.parse(await readFile(new URL('./i18n-exceptions.json', import.meta.url), 'utf8')),
  );
  for (const directory of sourceRoots) {
    for (const entry of await readdir(join(root, directory), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (
        !entry.isFile() ||
        !/\.(?:tsx?|mts|cts)$/u.test(entry.name) ||
        /\.(?:test|spec)\./u.test(entry.name)
      )
        continue;
      const path = join(entry.parentPath, entry.name);
      const file = relative(root, path).split('\\').join('/');
      const source = await readFile(path, 'utf8');
      for (const finding of scanI18nSource(source, entry.name.endsWith('.tsx'))) {
        const exception = exceptions.findIndex(
          (item) => item.file === file && item.fingerprint === finding.fingerprint,
        );
        if (exception >= 0) exceptions.splice(exception, 1);
        else
          problems.push(
            `${file}:${finding.line}: ${finding.sink} ${JSON.stringify(finding.text)} [${finding.fingerprint}]`,
          );
      }
    }
  }
  const html = await readFile(join(root, 'frontend/index.html'), 'utf8');
  if (/<title>(?!atelier<\/title>)[^<]*\p{L}[^<]*<\/title>/iu.test(html)) {
    problems.push('frontend/index.html: the translated title belongs in the application catalog');
  }
  for (const { file, fingerprint } of exceptions)
    problems.push(`${file}: obsolete i18n exception ${fingerprint}`);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else console.log('UI translations and message boundaries checked.');
}

if (import.meta.main) await main();
