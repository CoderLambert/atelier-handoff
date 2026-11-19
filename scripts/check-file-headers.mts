#!/usr/bin/env node
/**
 * @file 检查本次功能变更涉及的源文件是否包含维护说明。
 * @implementation 根据 Git 索引或指定基线定位变更，校验文件头字段与带时区的时间。
 * @updated 2026-11-20T02:00+08:00
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const [mode, ...paths] = args;
function changed(extra: string[]): string[] {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '-z', '--diff-filter=ACMR', ...extra, '--'],
    { cwd: root, encoding: 'utf8' },
  );
  return output.split('\0').filter(Boolean);
}
let files: string[];
if (mode === '--files' && paths.length) files = paths;
else if (mode === '--base' && paths.length === 1 && paths[0] && !paths[0].startsWith('-'))
  files = changed([`${paths[0]}...HEAD`]);
else if (args.length === 0) files = changed(['--cached']);
else throw new Error('Usage: check:headers [--base <revision> | --files <paths...>]');

const issues: string[] = [];
let count = 0;
for (const file of files) {
  if (
    !/^(desktop|frontend\/src|server|shared|scripts|tests|packages\/markdown)\//.test(file) ||
    !/\.(?:[cm]?ts|tsx|css)$|\/PKGBUILD$/.test(file)
  )
    continue;
  count++;
  const source =
    mode === '--files'
      ? await readFile(resolve(root, file), 'utf8')
      : execFileSync('git', ['show', `${mode === '--base' ? 'HEAD' : ''}:${file}`], {
          cwd: root,
          encoding: 'utf8',
        });
  const header =
    source
      .replace(/^#![^\n]*\n/, '')
      .match(/^(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*))+/)?.[0] ?? '';
  const updated =
    /@updated[ \t]+(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d))(?:\s|$)/.exec(
      header,
    )?.[1];
  if (
    !/@file[ \t]+\S/.test(header) ||
    !/@implementation[ \t]+\S/.test(header) ||
    !updated ||
    !Number.isFinite(Date.parse(updated))
  )
    issues.push(file);
}
if (mode === '--files' && count === 0) throw new Error('未指定可检查的源码文件。');
if (issues.length) throw new Error(`请按文件维护规则更新文件头：\n${issues.join('\n')}`);
console.log(`File maintenance headers verified: ${count} changed sources.`);
