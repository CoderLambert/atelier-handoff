/**
 * @file 构建桌面主进程和预加载脚本。
 * @implementation 使用 esbuild 分别输出 ESM 主进程和 CommonJS 预加载包。
 * @updated 2026-11-20T02:00+08:00
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  target: 'node24',
  external: ['electron'],
  sourcemap: true,
} as const;

await Promise.all([
  build({
    ...base,
    external: [...base.external],
    entryPoints: ['desktop/main.mts'],
    format: 'esm',
    outfile: 'dist/desktop/main.mjs',
  }),
  build({
    ...base,
    external: [...base.external],
    entryPoints: ['desktop/preload.cts'],
    format: 'cjs',
    outfile: 'dist/desktop/preload.cjs',
  }),
]);
