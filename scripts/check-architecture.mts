/**
 * @file 检查项目架构规则和源码边界。
 * @implementation 验证规则引用、路径范围与源码扩展名，并检查 P2 导入边界和宿主模块循环。
 * @updated 2026-11-20T02:27:00+08:00
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { matchesGlob, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { checkImportBoundaries } from './check-import-boundaries.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const rules = {
  frontend: ['frontend/src/app/workspace.tsx', 'packages/markdown/src/index.tsx'],
  'component-ui': [
    'frontend/src/components/ui/dialog.tsx',
    'frontend/src/features/chat/composer.tsx',
    'frontend/src/styles.css',
  ],
  desktop: [
    'desktop/main.mts',
    'desktop/preload.cts',
    'scripts/linux/package.mts',
    'scripts/smoke-linux.mts',
  ],
  api: ['server/app.ts', 'shared/types.ts', 'frontend/src/api/client.ts'],
  state: ['frontend/src/app/drafts.ts', 'frontend/src/app/store.ts', 'server/store.ts'],
  features: [
    'frontend/src/features/extensions/editor.tsx',
    'server/artifacts.ts',
    'packages/markdown/src/index.tsx',
  ],
};

const claude = await readFile(resolve(root, 'CLAUDE.md'), 'utf8');
assert.match(claude, /^@AGENTS\.md$/m, 'CLAUDE.md must load the project-wide instructions');
const agents = await readFile(resolve(root, 'AGENTS.md'), 'utf8');
const decisions = await readFile(resolve(root, '.claude/rules/technical-decisions.md'), 'utf8');
assert.ok(
  !decisions.startsWith('---') && agents.includes('.claude/rules/technical-decisions.md'),
  'Architecture research guidance must apply project-wide',
);
const scope = z.object({ paths: z.array(z.string().min(1)).nonempty() }).strict();
for (const [domain, examples] of Object.entries(rules)) {
  const path = `.claude/rules/${domain}.md`;
  assert.ok(agents.includes(path), `AGENTS.md must link ${path}`);
  const source = await readFile(resolve(root, path), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source)?.[1];
  assert.ok(frontmatter, `Missing paths frontmatter in ${path}`);
  const doc = parseDocument(frontmatter);
  assert.equal(doc.errors.length, 0, `Invalid YAML in ${path}`);
  const { paths } = scope.parse(doc.toJS());
  for (const example of examples) {
    assert.ok(
      paths.some((pattern) => matchesGlob(example, pattern)),
      `${path} does not cover ${example}`,
    );
  }
}

// Workbench code is authored in TypeScript. Platform manifests and built assets have their own formats.
const sourceDirs = [
  'desktop',
  'server',
  'shared',
  'frontend/src',
  'scripts',
  'packages/markdown/src',
  'packages/markdown/scripts',
];
for (const dir of sourceDirs) {
  const base = resolve(root, dir);
  const entries = await readdir(base, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile() && /\.[cm]?jsx?$/.test(entry.name)) {
      throw new Error(
        `Use TypeScript source for ${relative(root, resolve(entry.parentPath, entry.name))}`,
      );
    }
  }
}
const importErrors = await checkImportBoundaries(root);
assert.equal(importErrors.length, 0, importErrors.join('\n'));
console.log(
  'Architecture rules: six path scopes, TypeScript source boundaries and P2 import boundaries checked.',
);
