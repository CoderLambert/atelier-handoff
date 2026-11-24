/**
 * @file 验证恢复日志先于数据库写入时的安全放弃入口。
 * @implementation 在隔离 Git 仓库真实强杀执行进程，并通过 HTTP 对账和清理自有索引锁。
 * @updated 2026-11-24T14:41:22+08:00
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { LocalGit } from '../server/modules/git/git-cli.js';
import { readCommitPlanSnapshot } from '../server/modules/git/commit-plan-snapshot.js';
import { compileCommitPlan } from '../server/modules/git/commit-plan-compiler.js';
import { CommitJournal } from '../server/modules/git/commit-journal.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

test('a prepared journal without a database claim remains visible and can be safely abandoned', async () => {
  const base = await mkdtemp(join(tmpdir(), 'atelier-multi-orphan-'));
  const repo = join(base, 'project');
  const data = join(base, 'data');
  const otherRepo = join(base, 'other-project');
  await mkdir(repo);
  await mkdir(otherRepo);
  git(otherRepo, 'init', '-b', 'main');
  await mkdir(data, { mode: 0o700 });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(repo, 'file.txt'), 'before\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  await writeFile(join(repo, 'file.txt'), 'after\n');
  const oldHead = git(repo, 'rev-parse', 'HEAD').trim();
  const oldIndex = await readFile(join(repo, '.git/index'));
  const store = new Store(data);
  const projectId = randomUUID();
  store.put('projects', {
    id: projectId,
    name: 'Fixture',
    path: repo,
    branch: 'main',
    available: true,
    createdAt: new Date().toISOString(),
  });
  const otherProjectId = randomUUID();
  store.put('projects', {
    id: otherProjectId,
    name: 'Other fixture',
    path: otherRepo,
    branch: 'main',
    available: true,
    createdAt: new Date().toISOString(),
  });
  const gitClient = await LocalGit.open(repo);
  const snapshot = await readCommitPlanSnapshot(gitClient);
  const plan = compileCommitPlan(snapshot, {
    groups: [{ title: 'Fixture', body: '', unitIds: snapshot.units.map((unit) => unit.id) }],
    excludedUnitIds: [],
  });
  const operationId = randomUUID();
  const digest = 'a'.repeat(64);
  const module = (name: string) =>
    new URL('../server/modules/git/' + name + '.ts', import.meta.url).href;
  const script = `
    import {Store} from ${JSON.stringify(new URL('../server/store.ts', import.meta.url).href)};
    import {LocalGit,fileIdentity} from ${JSON.stringify(module('git-cli'))};
    import {CommitJournal} from ${JSON.stringify(module('commit-journal'))};
    import {commitPlanCoordinator} from ${JSON.stringify(module('commit-plan-coordinator'))};
    import {executeCommitPlan} from ${JSON.stringify(module('commit-plan-execution'))};
    const [repo,data,projectId,digest,id,snapshot,plan]=process.argv.slice(1);
    const store=new Store(data), git=await LocalGit.open(repo), journal=new CommitJournal(data);
    const base=commitPlanCoordinator(store,journal,projectId,git.repositoryId,await fileIdentity(repo),await fileIdentity(git.admin),digest);
    const coordinator={...base,prepare:async input=>{await journal.prepare({...input,owner:{projectId,requestDigest:digest}});process.kill(process.pid,'SIGKILL')}};
    await executeCommitPlan(git,JSON.parse(snapshot),JSON.parse(plan),{operationId:id,coordinator});
  `;
  store.close();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        repo,
        data,
        projectId,
        digest,
        operationId,
        JSON.stringify(snapshot),
        JSON.stringify(plan),
      ],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), oldHead);
    assert.ok((await lstat(join(repo, '.git/index.lock'))).isFile());
    app = await createApp({ root, data });
    await new Promise<void>((resolve) => app?.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const boot = (await fetch(origin + '/api/bootstrap').then((response) => response.json())) as {
      csrfToken: string;
    };
    const prefix = `/api/projects/${projectId}/git/worktrees/${projectId}`;
    const pending = await fetch(origin + prefix + '/commit-plan-pending');
    const evidence = await new CommitJournal(data).read(operationId);
    assert.ok(evidence);
    assert.deepEqual(await pending.json(), {
      items: [{ operationId, state: 'prepared', commits: evidence.commits }],
    });
    const wrongPrefix = `/api/projects/${otherProjectId}/git/worktrees/${otherProjectId}`;
    const foreign = await fetch(origin + wrongPrefix + '/commit-plan-abandon', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-atelier-token': boot.csrfToken },
      body: JSON.stringify({ operationId }),
    });
    assert.equal(foreign.status, 409);
    assert.ok((await lstat(join(repo, '.git/index.lock'))).isFile());
    const abandoned = await fetch(origin + prefix + '/commit-plan-abandon', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-atelier-token': boot.csrfToken },
      body: JSON.stringify({ operationId }),
    });
    assert.equal(abandoned.status, 200, await abandoned.clone().text());
    assert.deepEqual(await abandoned.json(), { operationId, aborted: true });
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), oldHead);
    assert.deepEqual(await readFile(join(repo, '.git/index')), oldIndex);
    assert.equal(await readFile(join(repo, 'file.txt'), 'utf8'), 'after\n');
    await assert.rejects(lstat(join(repo, '.git/index.lock')), { code: 'ENOENT' });
    assert.deepEqual(
      await fetch(origin + prefix + '/commit-plan-pending').then((res) => res.json()),
      { items: [] },
    );
  } finally {
    await app?.close();
    await rm(base, { recursive: true, force: true });
  }
});
