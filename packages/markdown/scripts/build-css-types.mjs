import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

const vendors = ['streamdown', '@streamdown/code'];
const scanner = new Scanner({
  sources: vendors.map((vendor) => ({
    base: dirname(fileURLToPath(import.meta.resolve(vendor))),
    pattern: '*.js',
    negated: false,
  })),
});
const compiler = await compile(
  `@import 'tailwindcss/theme.css' layer(atelier-markdown-theme) prefix(am);
   @import 'tailwindcss/utilities.css' layer(atelier-markdown-utilities) prefix(am) source(none);
   @custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *));
   @theme inline {
     --color-background: var(--markdown-bg, #fff);
     --color-foreground: var(--markdown-fg, #18202b);
     --color-border: var(--markdown-border, #d1d5db);
     --color-muted: var(--markdown-muted, #f3f4f6);
     --color-muted-foreground: var(--markdown-muted-fg, #526072);
     --color-sidebar: var(--markdown-muted, #f3f4f6);
     --color-card: var(--markdown-bg, #fff);
   }`,
  { base: fileURLToPath(new URL('..', import.meta.url)), onDependency() {} },
);
const utilities = compiler.build(scanner.scan().map((candidate) => `am:${candidate}`));
const css = new URL('../dist/style.css', import.meta.url);
await writeFile(css, `${utilities}\n${await readFile(css, 'utf8')}`);
await writeFile(new URL('../dist/style.css.d.ts', import.meta.url), 'export {};\n');

const katexCss = import.meta.resolve('katex/dist/katex.min.css');
const tailwindCss = import.meta.resolve('tailwindcss');
await Promise.all([
  copyFile(new URL('../LICENSE', katexCss), new URL('../dist/LICENSE-KaTeX', import.meta.url)),
  copyFile(
    new URL('../LICENSE', tailwindCss),
    new URL('../dist/LICENSE-Tailwind', import.meta.url),
  ),
]);
