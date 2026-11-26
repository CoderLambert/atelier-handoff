/**
 * @file 管理运行时 Skill 包资源与脚本执行。
 * @implementation 校验包内路径，读取文本资源，写入临时包目录并通过受控 Python 执行器发布允许的产物。
 * @updated 2026-11-26T15:53:01+08:00
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError, type Run, type SkillPackage } from '../shared/types.js';
import type { FileRecords } from './artifacts.js';
import type { RunSkill } from './run-skills.js';
import { runPackagePython } from './skill-package-execution.js';

const searchDigest = 'c65ec10e007a3e4c898a930099abc65e81be6e27093c77c7b83bef4332ebf168';
export function supportsSearch(skill: RunSkill) {
  return skill.package?.digest === searchDigest;
}

export function readSkillResource(skill: RunSkill, path: string) {
  const unavailable = () =>
    new AppError('SKILL_RESOURCE_UNAVAILABLE', '此 Skill 包没有对应的文本资源。', 404);
  const file = skill.package?.files.find((file) => file.path === path);
  if (!file) throw unavailable();
  const bytes = Buffer.from(file.data, 'base64');
  if (bytes.length > 65_000)
    throw new AppError('SKILL_RESOURCE_TOO_LARGE', '资源超过读取上限。', 413);
  try {
    if (bytes.includes(0)) throw unavailable();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unavailable();
  }
}

export async function writeSkillPackage(root: string, pkg: SkillPackage, omitDocument = false) {
  for (const file of pkg.files) {
    if (omitDocument && file.path === 'SKILL.md') continue;
    if (
      !file.path ||
      file.path
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part))
    )
      throw new AppError('SKILL_PACKAGE_INVALID', '技能包路径无效。', 400);
    const destination = join(root, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, Buffer.from(file.data, 'base64'), {
      mode: file.executable ? 0o700 : 0o600,
      flag: 'wx',
    });
  }
}

export async function executeSkillPackage(options: {
  storage: string;
  run: Run;
  skill: RunSkill;
  script: string;
  args: string[];
  search?: boolean;
  signal: AbortSignal;
  files: FileRecords;
  validate: () => void;
}) {
  const { storage, run, skill, script, signal } = options;
  if (!skill.package?.files.some((file) => file.path === script) || !/\.py$/i.test(script))
    throw new AppError('SKILL_SCRIPT_UNAVAILABLE', '请选择本技能包内的 Python 入口。', 400);
  if (options.search && (!supportsSearch(skill) || script !== 'scripts/gateway.py'))
    throw new AppError('SKILL_SCRIPT_UNAVAILABLE', '此技能版本没有可用的联网适配。', 400);
  const scratch = await mkdtemp(join(storage, 'skill-run-'));
  try {
    const root = join(scratch, 'package');
    const output = join(scratch, 'output');
    const state = options.search
      ? join(storage, 'skill-state', run.projectId, skill.id)
      : join(scratch, 'state');
    for (const dir of [root, output, state]) await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeSkillPackage(root, skill.package);
    options.validate();
    const result = await runPackagePython({
      root,
      script,
      args: options.args,
      state,
      output,
      signal,
      search: options.search,
    });
    const artifacts = [];
    if (result.code === 0 && (!run.agent || run.agent.capabilities.includes('artifact'))) {
      const names = (await readdir(output, { withFileTypes: true })).filter(
        (item) => item.isFile() && /\.(?:pdf|md|csv|txt|html)$/i.test(item.name),
      );
      for (const entry of names.slice(0, 10)) {
        options.validate();
        const artifact = await options.files.publishFile(run, output, entry.name);
        artifacts.push({ id: artifact.id, name: artifact.name });
      }
    }
    const text = options.search
      ? result.output.replaceAll(
          'http://127.0.0.1:17863/checkout',
          'https://skill.zhaopintong.com/checkout',
        )
      : result.output;
    return { ...result, output: text, artifacts };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
