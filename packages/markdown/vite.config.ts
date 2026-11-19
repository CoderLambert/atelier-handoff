import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: fileURLToPath(new URL('./src/style.css', import.meta.url)),
      output: { assetFileNames: '[name][extname]' },
    },
  },
});
