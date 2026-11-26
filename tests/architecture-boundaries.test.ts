/**
 * @file 验证跨层导入、宿主循环和运行时入口边界。
 * @implementation 在临时源码树中覆盖解析规则、允许的依赖方向及组合入口和 HTTP 文件的行数限制。
 * @updated 2026-11-27T00:10:00+08:00
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkImportBoundaries } from '../scripts/check-import-boundaries.mjs';

async function check(sources: Record<string, string>): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'atelier-architecture-'));
  try {
    for (const directory of [
      'desktop',
      'server',
      'shared',
      'frontend/src',
      'scripts',
      'packages/markdown/src',
      'packages/markdown/scripts',
    ])
      await mkdir(join(root, directory), { recursive: true });
    for (const [file, source] of Object.entries({
      'frontend/tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/*'], '@shared/*': ['../shared/*'] } },
      }),
      'desktop/host/runtime.mts': 'export interface Runtime {}',
      'desktop/host/window.mts': 'export const window = 1;',
      'desktop/preload.cts': 'export {};',
      'server/main.ts': 'export const server = 1;',
      'frontend/src/app.tsx': 'export const app = <main />;',
      'shared/desktop-host.ts': 'export interface Host {}',
      ...sources,
    })) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), source);
    }
    return await checkImportBoundaries(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('runtime routes can call domain use cases, but neither can import composition', async () => {
  const allowed = {
    'server/app.ts': `import './http/git/routes.js'; import './modules/git/service.js';`,
    'server/http/git/routes.ts': `import '../../modules/git/service.js';`,
    'server/modules/git/service.ts': 'export const useCase = 1;',
  };
  assert.deepEqual(await check(allowed), []);
  const errors = await check({
    ...allowed,
    'server/http/git/bad.ts': `import '../../app.js';`,
    'server/modules/git/bad.ts': `export * from '../../http/git/routes.js'; import '../../main.js';`,
  });
  assert.equal(
    errors.filter((error) => error.includes('cannot import runtime composition')).length,
    2,
  );
  assert.equal(errors.filter((error) => error.includes('cannot import HTTP adapters')).length, 1);
});

test('the runtime entry and HTTP files have independent size limits', async () => {
  const lines = (count: number) => 'export {};\n' + '// line\n'.repeat(count - 1);
  assert.deepEqual(
    await check({
      'server/app.ts': lines(300),
      'server/http/git/routes.ts': lines(350),
      'server/modules/git/service.ts': lines(351),
    }),
    [],
  );
  const errors = await check({
    'server/app.ts': lines(301),
    'server/http/git/routes.ts': lines(351),
  });
  assert.ok(errors.some((error) => error.includes('server/app.ts: 301 lines')));
  assert.ok(errors.some((error) => error.includes('server/http/git/routes.ts: 351 lines')));
});

test('P2 composition, shared contracts and one-way host dependencies are allowed', async () => {
  assert.deepEqual(
    await check({
      'desktop/main.mts': `import './host/runtime.mjs'; import './host/window.mjs';`,
      'desktop/host/window.mts': `import type { Runtime } from './runtime.mjs';`,
      'desktop/host/runtime.mts': `import type { Host } from '../../shared/desktop-host.js';`,
      'desktop/preload.cts': `import type { Host } from '../shared/desktop-host.js';`,
      'frontend/src/use-host.ts': `import type { Host } from '@shared/desktop-host';`,
      'server/main.ts': `import type { Host } from '../shared/desktop-host.js';`,
      'frontend/src/model.test.ts': `import test from 'node:test'; import assert from 'node:assert/strict';`,
    }),
    [],
  );
});

for (const specifier of [
  'node:fs',
  'node:sqlite',
  'fs/promises',
  'fs/promises?raw',
  'electron?raw',
  'child_process',
  'electron',
  'electron/renderer',
  '@electron/remote',
]) {
  test(`frontend rejects runtime module ${specifier}`, async () => {
    const errors = await check({ 'frontend/src/bad.ts': `import '${specifier}';` });
    assert.ok(
      errors.some((error) => error.includes('cannot import Node or Electron')),
      errors.join('\n'),
    );
  });
}

for (const [name, source] of [
  ['static import', `import '../../desktop/host/runtime.mjs';`],
  ['type import', `import type { Runtime } from '../../desktop/host/runtime.mjs';`],
  ['named re-export', `export { server } from '../../server/main.js';`],
  ['star re-export', `export * from '../../desktop/preload.cjs';`],
  ['dynamic import', `void import('../../server/main.js');`],
  ['template import', 'void import(`../../server/main.js`);'],
  ['require', `require('../../server/main.js');`],
  ['require.resolve', `require.resolve('../../server/main.js');`],
  ['import equals', `import server = require('../../server/main.js');`],
  ['inline import type', `type Runtime = import('../../desktop/host/runtime.mjs').Runtime;`],
  ['frontend alias traversal', `import '@/../../server/main.js';`],
  ['shared alias traversal', `export * from '@shared/../server/main.js';`],
  ['Vite root path', `import '/desktop/host/runtime.mjs?raw';`],
] as const) {
  test(`frontend rejects application implementations through ${name}`, async () => {
    const errors = await check({ 'frontend/src/bad.ts': source });
    assert.ok(
      errors.some((error) => error.includes('frontend cannot import desktop/server')),
      errors.join('\n'),
    );
  });
}

test('frontend aliases prefer exact names and try existing fallback targets', async () => {
  const errors = await check({
    'frontend/tsconfig.json': JSON.stringify({
      compilerOptions: {
        paths: {
          '@layer/*': ['./src/*'],
          '@layer/runtime': ['../server/main.ts'],
          '@fallback/*': ['./missing/*', '../server/*'],
        },
      },
    }),
    'frontend/src/bad.ts': `import '@layer/runtime'; import '@fallback/main.js';`,
  });
  assert.equal(
    errors.filter((error) => error.includes('frontend cannot import desktop/server')).length,
    2,
  );
});

test('shared contracts cannot depend on application implementations', async () => {
  const errors = await check({
    'shared/desktop-host.ts': `
      export * from '../server/main.js';
      export type { Runtime } from '../desktop/host/runtime.mjs';
      import '../frontend/src/app.js';
    `,
  });
  assert.equal(
    errors.filter((error) => error.includes('shared cannot import application')).length,
    3,
  );
});

test('shared contracts cannot pull Node runtime into frontend transitively', async () => {
  const errors = await check({
    'shared/desktop-host.ts': `import { readFile } from 'node:fs/promises';`,
  });
  assert.ok(
    errors.some((error) => error.includes('cannot import Node or Electron')),
    errors.join('\n'),
  );
});

test('desktop cannot reach runtime or frontend implementations', async () => {
  const errors = await check({
    'desktop/host/runtime.mts': `import '../../server/main.js';`,
    'desktop/main.mts': `import '../frontend/src/app.js';`,
    'desktop/preload.cts': `import '../packages/markdown/src/index.js';`,
    'packages/markdown/src/index.tsx': `export const markdown = <main />;`,
  });
  assert.equal(
    errors.filter((error) => error.includes('desktop cannot import runtime/frontend')).length,
    3,
  );
});

test('private host imports are restricted to the composition entry and host peers', async () => {
  const errors = await check({
    'desktop/other.mts': `export * from './host/window.mjs';`,
    'desktop/preload.cts': `void import('./host/runtime.mjs');`,
    'server/main.ts': `import '../desktop/host/runtime.mjs';`,
    'scripts/other.mts': `import '../desktop/host/window.mjs';`,
  });
  assert.equal(errors.filter((error) => error.includes('private desktop/host')).length, 4);
});

test('host cycles resolve .mjs, .js and directory indexes, including type edges', async () => {
  const errors = await check({
    'desktop/host/runtime.mts': `import type { Window } from './window.mjs';`,
    'desktop/host/window.mts': `export * from './support';`,
    'desktop/host/support/index.ts': `export type { Runtime } from '../runtime.mjs';`,
  });
  assert.ok(
    errors.some((error) =>
      error.includes(
        'desktop/host/runtime.mts -> desktop/host/window.mts -> desktop/host/support/index.ts -> desktop/host/runtime.mts',
      ),
    ),
    errors.join('\n'),
  );
});

test('host cycles include static dynamic imports and CommonJS source extensions', async () => {
  const errors = await check({
    'desktop/host/runtime.mts': `void import('./bridge.cjs');`,
    'desktop/host/bridge.cts': `require('./runtime.mjs');`,
  });
  assert.ok(
    errors.some((error) => error.includes('desktop/host dependency cycle')),
    errors.join('\n'),
  );
});

test('host self-imports are cycles', async () => {
  const errors = await check({ 'desktop/host/runtime.mts': `import './runtime.mjs';` });
  assert.ok(
    errors.some((error) => error.includes('desktop/host/runtime.mts -> desktop/host/runtime.mts')),
  );
});

test('source text, property names and import.meta URLs are not import edges', async () => {
  assert.deepEqual(
    await check({
      'frontend/src/strings.ts': `
        const example = "import 'node:fs';";
        const object = { require: 'electron' };
        // import '../../desktop/host/runtime.mjs';
      `,
      'desktop/host/runtime.mts': `new URL('../../server/main.js', import.meta.url);`,
    }),
    [],
  );
});
