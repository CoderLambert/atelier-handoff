/**
 * @file 验证 RTK 自动包装的固定命令范围与资源失效行为。
 * @implementation 使用含空格和引号的路径核对完整命令，只接受精确形式，并拒绝残缺或错误版本的随包资源。
 * @updated 2026-11-26T01:58:00+08:00
 */
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rtkLauncher } from '../shared/builtin-rtk.js';
import { builtinRtkAvailable } from '../server/builtin-rtk.js';
import { planBuiltinRtkCommand } from '../server/rtk-rewrite.js';

test(
  'the shipped RTK supplies command families and preserves shell/data boundaries',
  {
    skip:
      process.platform !== 'linux' ||
      process.arch !== 'x64' ||
      !process.env.ATELIER_TEST_RTK_BINARY,
  },
  async () => {
    const supplied = process.env.ATELIER_TEST_RTK_BINARY;
    assert.ok(supplied);
    const root = await mkdtemp(join(tmpdir(), "atelier-rtk's commands-"));
    try {
      const scratch = join(root, 'private-config');
      const binary = join(root, 'rtk');
      const launcher = join(root, 'bin', 'rtk');
      await mkdir(scratch);
      await mkdir(join(root, 'bin'));
      await mkdir(join(root, '.claude'));
      await writeFile(
        join(root, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { deny: ['Bash(ls:*)'] } }),
      );
      await copyFile(supplied, binary);
      await chmod(binary, 0o700);
      await writeFile(launcher, rtkLauncher, { mode: 0o700 });
      assert.equal(await builtinRtkAvailable(binary), true);
      const prefix = "'" + launcher.replaceAll("'", "'\\''") + "'";
      const tool = prefix + ' --atelier-exec';
      const ahead = 'git rev-list --left-right --count HEAD...origin/branch';
      const details = 'git log --oneline --left-right HEAD...origin/branch';
      const cases = [
        ['git diff --stat', prefix + ' git diff --stat'],
        ['git log --oneline -20', prefix + ' git log --oneline -20'],
        [
          'git fetch --all && git branch -a -vv && git remote',
          prefix + ' git fetch --all && git branch -a -vv && git remote',
        ],
        [
          ahead + ' && ' + details + ' && git status --short',
          ahead + ' && ' + details + ' && ' + prefix + ' git status --short',
        ],
        ['ls -la  && rg -n "a && b" .', tool + ' ls -la  && ' + tool + ' rg -n "a && b" .'],
        ['cat fixture.txt', tool + ' read fixture.txt'],
        ['npm test -- --probe', tool + ' npm run test -- --probe'],
        ['npm run lint -- --max-warnings 7', tool + ' npm run lint -- --max-warnings 7'],
        ['npm run build', tool + ' npm run build'],
        ['cargo test', tool + ' cargo test'],
        ['pnpm install', tool + ' pnpm install'],
        ['docker ps', tool + ' docker ps'],
        ['git status --porcelain=v2 -z && ls', 'git status --porcelain=v2 -z && ' + tool + ' ls'],
        ['rtk bypass git log && ls', 'rtk bypass git log && ' + tool + ' ls'],
        ["printf '%s' 'rtk ls' && ls", "printf '%s' 'rtk ls' && " + tool + ' ls'],
      ] as const;
      for (const [command, expected] of cases) {
        assert.equal(
          await planBuiltinRtkCommand(command, { launcher, scratch }),
          expected,
          command,
        );
      }
      for (const command of [
        'rg --json needle .',
        'kubectl get pods -o json',
        'kubectl get pods -ojson',
        'kubectl get pods --output=json',
        'cat -n a.txt b.txt',
        'tree -aJ',
        'tree -X',
        'vitest --reporter=json',
        'git log | wc -l',
        'git status > file',
        'git $(printf status)',
        'if true; then ls; fi',
        'source ./script && ls',
        'rtk bypass git log',
        'ssh host ls',
      ]) {
        assert.equal(
          await planBuiltinRtkCommand(command, { launcher, scratch }),
          undefined,
          command,
        );
      }
      assert.equal(
        await planBuiltinRtkCommand('git status', { launcher: join(scratch, 'missing'), scratch }),
        undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('unavailable or unpinned RTK resources keep native Bash available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-invalid-rtk-'));
  try {
    const binary = join(root, 'rtk');
    const launcher = join(root, 'bin', 'rtk');
    assert.equal(await builtinRtkAvailable(undefined), false);
    assert.equal(await builtinRtkAvailable('rtk'), false);
    assert.equal(await builtinRtkAvailable(binary), false);
    await mkdir(join(root, 'bin'));
    await writeFile(launcher, rtkLauncher, { mode: 0o700 });
    await writeFile(binary, 'wrong release', { mode: 0o700 });
    assert.equal(await builtinRtkAvailable(binary), false);
    await chmod(launcher, 0o600);
    assert.equal(await builtinRtkAvailable(binary), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
