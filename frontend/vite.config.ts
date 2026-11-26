/**
 * @file 配置工作台前端开发服务器与构建。
 * @implementation 配置 React、Tailwind、模块别名和访问范围，将本机 API 的 HTTP 与 WebSocket 请求代理到运行时。
 * @updated 2026-11-26T04:17:21+08:00
 */
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const directory = fileURLToPath(new URL('.', import.meta.url));
const workspace = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspace, 'ATELIER_');
  const backendPort = Number(process.env.ATELIER_PORT ?? env.ATELIER_PORT ?? '4317');
  return {
    root: directory,
    envDir: workspace,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      // Match the production image policy when previewing Markdown files.
      headers: { 'Content-Security-Policy': "img-src 'self' data:" },
      fs: {
        allow: [
          directory,
          fileURLToPath(new URL('../shared', import.meta.url)),
          // Vite resolves the npm workspace symlink to the package's build directory.
          fileURLToPath(new URL('../packages/markdown/dist', import.meta.url)),
          fileURLToPath(new URL('../node_modules', import.meta.url)),
        ],
        deny: [
          '.env',
          '.env.*',
          '*.{crt,pem}',
          '**/.git/**',
          '**/.data/**',
          '**/.local/**',
          '**/.claude/**',
        ],
      },
      proxy: {
        '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false, ws: true },
      },
    },
    build: { outDir: '../dist/client', emptyOutDir: true },
  };
});
