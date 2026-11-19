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
      proxy: { '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false } },
    },
    build: { outDir: '../dist/client', emptyOutDir: true },
  };
});
