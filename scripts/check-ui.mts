/**
 * @file 检查前端的主题、控件与动效约定。
 * @implementation 用 Babel 和 PostCSS 识别明确的静态展示层写法，并按文件位置报告违规。
 * @updated 2026-11-23T04:49:37+08:00
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import * as t from '@babel/types';
import postcss from 'postcss';

interface Violation {
  rule: 'color' | 'legacy-control' | 'icon-label' | 'motion-import' | 'scrollbar' | 'focus-outline';
  detail: string;
  line: number;
}

const paletteClass =
  /(?:^|:)(?:bg|text|border(?:-[trblxyse])?|ring|outline|fill|stroke|from|via|to|accent|divide|decoration|caret)-(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})(?:[/!]|$)/;
const hexColor = /#[\da-f]{3,8}\b/i;
const colorFunction = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(\s*[\d.+-]/i;
const oldControlClass = /^(?:btn(?:-(?:primary|secondary|ghost|danger))?|icon-button)$/;
const literal = (value: t.Node | null | undefined) =>
  t.isStringLiteral(value) ? value.value : undefined;

function checkClasses(value: string, line: number, violations: Violation[]) {
  for (const token of value.split(/\s+/)) {
    if (oldControlClass.test(token))
      violations.push({ rule: 'legacy-control', detail: token, line });
    if (
      paletteClass.test(token) ||
      (/(?:bg|text|border|fill|stroke|ring)-\[/.test(token) &&
        (hexColor.test(token) || colorFunction.test(token)))
    ) {
      violations.push({ rule: 'color', detail: token, line });
    }
  }
}

function checkTsx(source: string): Violation[] {
  const tree = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const buttons = new Set<string>();
  const violations: Violation[] = [];
  for (const node of tree.program.body) {
    if (!t.isImportDeclaration(node) || node.importKind === 'type') continue;
    const path = node.source.value;
    for (const spec of node.specifiers) {
      if (!t.isImportSpecifier(spec) || spec.importKind === 'type') continue;
      const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
      if (path.endsWith('/ui/button') || path === './button') {
        if (imported === 'Button') buttons.add(spec.local.name);
      }
      if ((path === 'motion/react' || path === 'framer-motion') && imported === 'motion') {
        violations.push({
          rule: 'motion-import',
          detail: `${path}:motion`,
          line: node.loc?.start.line ?? 1,
        });
      }
    }
  }
  t.traverseFast(tree, (node) => {
    if (!t.isJSXOpeningElement(node)) return;
    const line = node.loc?.start.line ?? 1;
    const attributes = new Map(
      node.attributes
        .filter((attribute) => t.isJSXAttribute(attribute))
        .flatMap((attribute) =>
          t.isJSXIdentifier(attribute.name)
            ? [[attribute.name.name, attribute.value] as const]
            : [],
        ),
    );
    const className = attributes.get('className');
    if (t.isStringLiteral(className)) checkClasses(className.value, line, violations);
    if (t.isJSXExpressionContainer(className)) {
      t.traverseFast(className.expression, (part) => {
        if (t.isStringLiteral(part)) checkClasses(part.value, line, violations);
        if (t.isTemplateElement(part)) checkClasses(part.value.raw, line, violations);
      });
    }
    const size = literal(attributes.get('size'));
    if (
      t.isJSXIdentifier(node.name) &&
      buttons.has(node.name.name) &&
      size?.startsWith('icon') &&
      !attributes.has('aria-label') &&
      !attributes.has('aria-labelledby') &&
      !node.attributes.some((attribute) => t.isJSXSpreadAttribute(attribute))
    ) {
      violations.push({ rule: 'icon-label', detail: `${node.name.name}:${size}`, line });
    }
  });
  return violations;
}

function checkCss(source: string, file: string): Violation[] {
  const violations: Violation[] = [];
  const root = postcss.parse(source, { from: file });
  if (file !== 'styles.css') {
    root.walkRules((rule) => {
      if (/::-webkit-scrollbar/.test(rule.selector)) {
        violations.push({
          rule: 'scrollbar',
          detail: rule.selector.trim(),
          line: rule.source?.start?.line ?? 1,
        });
      }
    });
  }
  root.walkDecls((declaration) => {
    if (
      file !== 'styles.css' &&
      (declaration.prop === 'scrollbar-color' ||
        (declaration.prop === 'scrollbar-width' && declaration.value.trim() !== 'none'))
    ) {
      violations.push({
        rule: 'scrollbar',
        detail: `${declaration.prop}:${declaration.value.trim()}`,
        line: declaration.source?.start?.line ?? 1,
      });
    }
    if (
      file === 'styles.css' &&
      declaration.prop.startsWith('--ui-') &&
      declaration.parent?.type === 'rule' &&
      declaration.parent.selector === ':root'
    )
      return;
    if (
      file !== 'styles.css' &&
      declaration.prop === 'outline' &&
      /\b2px\s+solid\b/i.test(declaration.value)
    ) {
      violations.push({
        rule: 'focus-outline',
        detail: `${declaration.prop}:${declaration.value.trim()}`,
        line: declaration.source?.start?.line ?? 1,
      });
    }
    if (declaration.prop === 'content') return;
    const value = declaration.value.replace(/url\([^)]*\)/gi, '');
    if (hexColor.test(value) || colorFunction.test(value)) {
      violations.push({
        rule: 'color',
        detail: `${declaration.prop}:${value.trim()}`,
        line: declaration.source?.start?.line ?? 1,
      });
    }
  });
  return violations;
}

if (process.argv.includes('--self-test')) {
  const sample = `import { Button as IconButton } from 'components/ui/button'; import { motion } from 'motion/react';
    const good = <IconButton size="icon" aria-label={t('close')} className="bg-primary" />;
    const bad = <IconButton size="icon" className={cn('btn text-amber-700', flag && 'bg-[#f22]')} />;`;
  assert.deepEqual(
    checkTsx(sample)
      .map(({ rule }) => rule)
      .sort(),
    ['color', 'color', 'icon-label', 'legacy-control', 'motion-import'],
  );
  assert.equal(
    checkCss(':root { --ui-card: #fff; } a { fill: url(#local); }', 'styles.css').length,
    0,
  );
  assert.equal(checkCss('.alert { background: rgb(12 20 30 / .4); }', 'feature.css').length, 1);
  assert.equal(
    checkCss('.item:focus-visible { outline: 2px solid var(--ui-ring); }', 'feature.css')[0]?.rule,
    'focus-outline',
  );
} else {
  const root = fileURLToPath(new URL('../frontend/src/', import.meta.url));
  const errors: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(tsx?|css)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name))
      continue;
    const path = join(entry.parentPath, entry.name);
    const file = relative(root, path).replaceAll('\\', '/');
    const source = await readFile(path, 'utf8');
    const violations = file.endsWith('.css') ? checkCss(source, file) : checkTsx(source);
    for (const { rule, detail, line } of violations)
      errors.push(`${file}:${line} ${rule}: ${detail}`);
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('UI semantics checked.');
}
