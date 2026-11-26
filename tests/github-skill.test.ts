/**
 * @file 验证公开 GitHub Skill 的发现、安装与更新。
 * @implementation 通过可控 GitHub 响应和隔离项目覆盖固定版本、安全校验、失败保留旧包及公开仓库认证。
 * @updated 2026-11-26T15:53:01+08:00
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { ProjectExtensions } from '../server/extensions.js';
import { readSkillResource } from '../server/skill-package-runtime.js';
import type { RunSkill } from '../server/run-skills.js';
import type { GitDevelopmentPreview, GitSessionWorkspace } from '../shared/git-workbench.js';
import type { PublicEntry } from '../shared/public-extensions.js';
import { now, type Extension, type Project, type Session } from '../shared/types.js';
import { authenticatedGithubFetch } from '../server/github-public-auth.js';
import { previewPublic } from '../server/public-extensions.js';

const repo = 'https://github.com/sample/skills';
const api = 'https://api.github.com/repos/sample/skills';
const raw = 'https://raw.githubusercontent.com/sample/skills';
const first = 'a'.repeat(40);
const second = 'b'.repeat(40);
const firstTree = 'c'.repeat(40);
const secondTree = 'd'.repeat(40);
const skillDir = 'skills/sample';
const skillTree = 'e'.repeat(40);
const alternateTree = 'f'.repeat(40);
const changedSkillTree = '1'.repeat(40);
const document = Buffer.from(
  '\uFEFF---\nname: sample\ndescription: A fixture\n---\nUse [notes](references/notes.md).\n',
);
const blob = (data: Buffer) =>
  createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const notes = Buffer.from('verified reference');
const script = Buffer.from('#!/bin/sh\nprintf fixture');
const binary = Buffer.from([0, 255, 1]);
const files = new Map([
  ['SKILL.md', document],
  ['references/notes.md', notes],
  ['scripts/sample', script],
  ['assets/bytes.bin', binary],
]);
function fixture() {
  const requests: string[] = [];
  let current = first;
  const request: typeof fetch = async (input, options) => {
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    const url = String(input);
    requests.push(url);
    if (url.startsWith(`${api}/commits/`)) {
      const ref = decodeURIComponent(url.slice(`${api}/commits/`.length));
      if (!['HEAD', 'feature/tools', first, second].includes(ref))
        return new Response('', { status: 404 });
      const sha = ref.length === 40 ? ref : current;
      return Response.json({
        sha,
        commit: { tree: { sha: sha === first ? firstTree : secondTree } },
      });
    }
    const branchFiles = (version: string, prefix = '') =>
      [...files.entries()].map(([path, data]) => {
        if (path === 'references/notes.md' && version === second)
          data = Buffer.from('changed reference');
        return {
          path: prefix + path,
          mode: path === 'scripts/sample' ? '100755' : '100644',
          type: 'blob',
          sha: blob(data),
          size: data.length,
        };
      });
    const tree = (path: string, sha: string) => ({ path, mode: '040000', type: 'tree', sha });
    const treeUrl = new URL(url);
    if (treeUrl.origin === 'https://api.github.com') {
      const id = treeUrl.pathname.split('/').at(-1);
      if (id === firstTree || id === secondTree) {
        const contents = treeUrl.search
          ? [
              ...branchFiles(first, '.agents/skills/sample/'),
              ...branchFiles(first, '.claude/skills/sample/'),
              ...branchFiles(id === firstTree ? first : second, skillDir + '/'),
            ]
          : [
              tree('.agents', '2'.repeat(40)),
              tree('skills', id === firstTree ? skillTree : changedSkillTree),
            ];
        return Response.json({ sha: id, truncated: false, tree: contents });
      }
      if (id === '2'.repeat(40))
        return Response.json({ sha: id, truncated: false, tree: [tree('skills', skillTree)] });
      if ((id === skillTree || id === changedSkillTree) && !treeUrl.search)
        return Response.json({
          sha: id,
          truncated: false,
          tree: [tree('sample', id === skillTree ? alternateTree : second)],
        });
      if (id === alternateTree || id === second)
        return Response.json({
          sha: id,
          truncated: false,
          tree: branchFiles(id === alternateTree ? first : second),
        });
    }
    if (url.startsWith(raw + '/')) {
      const [sha, ...segments] = url.slice(raw.length + 1).split('/');
      const path = segments.join('/');
      const relative = path.replace(/^(?:\.(?:claude|agents)\/)?skills\/sample\//, '');
      const data =
        relative === 'references/notes.md' && sha === second && !path.startsWith('.agents/')
          ? Buffer.from('changed reference')
          : files.get(relative);
      if (data) return new Response(new Uint8Array(data));
    }
    throw new Error(`Unexpected request ${url}`);
  };
  return {
    request,
    requests,
    moveRef: () => {
      current = second;
    },
  };
}

test('discovers duplicate display names, preferring Claude, and resolves a slash-containing branch', async () => {
  const { request } = fixture();
  const entries = await previewPublic(repo + '.git', 'skill', request);
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.key]),
    [
      ['sample', '.claude/skills/sample/SKILL.md'],
      ['sample', '.agents/skills/sample/SKILL.md'],
      ['sample', 'skills/sample/SKILL.md'],
    ],
  );
  assert.equal(entries[0]?.recommended, true);
  const [entry] = await previewPublic(repo + '/tree/feature/tools/skills/sample', 'skill', request);
  assert.equal(entry?.github?.ref, 'feature/tools');
  assert.equal(entry?.github?.commit, first);
  assert.equal(entry?.packageManifest?.executables?.[0], 'scripts/sample');
});

test('preview pins installation, preserving raw bytes and executable mode', async () => {
  const { request, requests, moveRef } = fixture();
  const [preview] = await previewPublic(
    repo + '/blob/feature/tools/skills/sample/SKILL.md',
    'skill',
    request,
  );
  assert.ok(preview?.github);
  assert.ok(preview.packageManifest?.digest);
  assert.equal(preview.package, undefined);
  assert.equal(requests.filter((url) => url.startsWith(raw)).length, 1);
  moveRef();
  const [installed] = await previewPublic(preview.location, 'skill', request, {
    github: preview.github,
    includePackage: true,
  });
  assert.equal(installed?.package?.digest, preview.packageManifest.digest);
  assert.equal(
    installed?.package?.files.find((file) => file.path === 'assets/bytes.bin')?.data,
    binary.toString('base64'),
  );
  assert.equal(
    installed?.package?.files.find((file) => file.path === 'scripts/sample')?.executable,
    true,
  );
  const [latest] = await previewPublic(preview.location, 'skill', request);
  assert.equal(latest?.revision, preview.revision);
  assert.notEqual(latest?.packageManifest?.digest, preview.packageManifest.digest);
});

test('rejects truncated trees, unsafe members, oversize files and corrupt bytes', async (t) => {
  const source = repo + '/blob/feature/tools/skills/sample/SKILL.md';
  const { request } = fixture();
  for (const [name, code, replace] of [
    [
      'truncated',
      'GITHUB_SKILL_TRUNCATED',
      (tree: Record<string, unknown>) => ({ ...tree, truncated: true }),
    ],
    [
      'oversize',
      'PUBLIC_SOURCE_TOO_LARGE',
      (tree: Record<string, unknown>) => ({
        ...tree,
        tree: [
          ...(tree.tree as unknown[]),
          { path: 'huge', size: 5 * 1024 * 1024, mode: '100644', type: 'blob', sha: first },
        ],
      }),
    ],
    [
      'unsafe path',
      'GITHUB_SKILL_UNSUPPORTED',
      (tree: Record<string, unknown>) => ({
        ...tree,
        tree: [
          ...(tree.tree as unknown[]),
          { path: '../outside', size: 1, mode: '100644', type: 'blob', sha: first },
        ],
      }),
    ],
    [
      'symlink',
      'GITHUB_SKILL_UNSUPPORTED',
      (tree: Record<string, unknown>) => ({
        ...tree,
        tree: [
          ...(tree.tree as unknown[]),
          { path: 'link', size: 1, mode: '120000', type: 'blob', sha: first },
        ],
      }),
    ],
    [
      'submodule',
      'GITHUB_SKILL_UNSUPPORTED',
      (tree: Record<string, unknown>) => ({
        ...tree,
        tree: [
          ...(tree.tree as unknown[]),
          { path: 'submodule', mode: '160000', type: 'commit', sha: first },
        ],
      }),
    ],
    [
      'case alias',
      'GITHUB_SKILL_UNSUPPORTED',
      (tree: Record<string, unknown>) => ({
        ...tree,
        tree: [
          ...(tree.tree as unknown[]),
          { path: 'References/other.md', size: 1, mode: '100644', type: 'blob', sha: first },
        ],
      }),
    ],
  ] as const) {
    await t.test(name, async () => {
      const modified: typeof fetch = async (input, options) => {
        const response = await request(input, options);
        return String(input).endsWith(`/git/trees/${alternateTree}?recursive=1`)
          ? Response.json(replace(await response.json()))
          : response;
      };
      await assert.rejects(previewPublic(source, 'skill', modified), { code });
    });
  }
  const corrupt: typeof fetch = (input, options) =>
    String(input).endsWith('/assets/bytes.bin')
      ? Promise.resolve(new Response(new Uint8Array([16, 255, 1])))
      : request(input, options);
  const [preview] = await previewPublic(source, 'skill', request);
  assert.ok(preview?.github);
  await assert.rejects(
    previewPublic(preview.location, 'skill', corrupt, {
      github: preview.github,
      includePackage: true,
    }),
    {
      code: 'PUBLIC_SOURCE_CHANGED',
    },
  );
});

test('HTTP import and update preserve project, pinned package bytes and old versions on failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-github-package-'));
  const projectDir = join(directory, 'project');
  const otherDir = join(directory, 'other');
  await mkdir(projectDir);
  await mkdir(otherDir);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', projectDir, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git(
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Fixture',
    'commit',
    '--allow-empty',
    '-m',
    'base',
  );
  const upstream = fixture();
  let interruption = false;
  const requests: Array<{ path?: string; prompt: string; skills: RunSkill[] }> = [];
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = await createApp({
    root,
    data: join(directory, 'data'),
    publicSourceFetch(input, options) {
      if (interruption && String(input).endsWith('/references/notes.md'))
        return Promise.reject(new Error('Connection interrupted'));
      return upstream.request(input, options);
    },
    runnerFactory: (store) => ({
      start(run, prompt, _mcp, skills = []) {
        requests.push({ path: run.workspacePath, prompt, skills });
        store.update('runs', run.id, { status: 'completed', endedAt: now() });
      },
      stop() {},
      async shutdown() {},
    }),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  let token = '';
  async function api<T>(path: string, method = 'GET', payload?: unknown, status = 200): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': token },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result as T;
  }
  token = (await api<{ csrfToken: string }>('/api/bootstrap')).csrfToken;
  const bind = (path: string) => api<{ project: Project }>('/api/projects', 'POST', { path }, 201);
  const { project } = await bind(projectDir);
  const { project: other } = await bind(otherDir);
  const endpoint = `/api/projects/${project.id}/extensions`;
  const source = repo + '/blob/feature/tools/skills/sample/SKILL.md';
  const preview = async (location = source) => {
    const { items } = await api<{ items: PublicEntry[] }>(endpoint + '/public-preview', 'POST', {
      source: location,
      kind: 'skill',
    });
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.ok(item.body && item.github && item.revision && item.packageManifest);
    assert.ok(!('package' in item));
    return {
      ...item,
      body: item.body,
      github: item.github,
      revision: item.revision,
      packageManifest: item.packageManifest,
    };
  };
  const input = (item: Awaited<ReturnType<typeof preview>>) => ({
    source: item.location,
    github: item.github,
    revision: item.revision,
    kind: item.kind,
    key: item.key,
    packageDigest: item.packageManifest.digest,
  });
  type Saved = { item: Extension; changed: boolean };
  const pre = await preview();
  const registry = new ProjectExtensions(app.store);
  const legacy = registry.savePublic(project.id, { ...pre, github: undefined }).item;
  const disabled = registry.save(
    project.id,
    { version: legacy.version, enabled: false },
    legacy.id,
  );
  const update = (item: Extension) => ({ id: item.id, version: item.version });
  const upgraded = (
    await api<Saved>(endpoint + '/public-import', 'POST', {
      ...input(pre),
      update: update(disabled),
    })
  ).item;
  assert.equal(upgraded.id, legacy.id);
  assert.equal(upgraded.enabled, false);
  assert.equal(upgraded.origin?.packageDigest, pre.packageManifest.digest);
  assert.equal(upgraded.origin?.github?.commit, first);
  const current = registry.save(
    project.id,
    { version: upgraded.version, enabled: true, autoInvoke: false },
    upgraded.id,
  );
  upstream.moveRef();
  const beforeRepeat = upstream.requests.length;
  interruption = true;
  const repeat = await api<Saved>(endpoint + '/public-import', 'POST', input(pre));
  interruption = false;
  assert.equal(upstream.requests.length, beforeRepeat);
  assert.equal(repeat.changed, false);
  assert.equal(repeat.item.id, upgraded.id);
  const newer = await preview(pre.location);
  assert.equal(pre.revision, newer.revision);
  assert.notEqual(pre.packageManifest.digest, newer.packageManifest.digest);
  interruption = true;
  const attemptedUpdate = { ...input(newer), update: update(current) };
  await api(endpoint + '/public-import', 'POST', attemptedUpdate, 502);
  assert.equal(registry.get(project.id, current.id).origin?.github?.commit, first);
  interruption = false;
  const synced = (await api<Saved>(endpoint + '/public-import', 'POST', attemptedUpdate)).item;
  assert.equal(synced.origin?.github?.commit, second);
  assert.equal(synced.enabled, true);
  const origin = registry.get(project.id, current.id);
  assert.ok(origin.kind === 'skill');
  assert.ok(origin.package?.files.find((file) => file.path === 'scripts/sample')?.executable);
  assert.equal(
    origin.package?.files.find((file) => file.path === 'SKILL.md')?.data,
    document.toString('base64'),
  );

  const alternate = await preview(repo + '/blob/HEAD/.agents/skills/sample/SKILL.md');
  const conflict = await api<{ error: { code: string } }>(
    endpoint + '/public-import',
    'POST',
    input(alternate),
    409,
  );
  assert.equal(conflict.error.code, 'EXTENSION_NAME_TAKEN');

  const createSession = (projectId: string) =>
    api<{ session: Session }>('/api/sessions', 'POST', { projectId }, 201);
  const ordinary = await createSession(project.id);
  const otherSession = await createSession(other.id);
  const gitUrl = `/api/projects/${project.id}/git`;
  const development = {
    requestId: randomUUID(),
    branch: 'use-skill',
    mode: 'linked',
    base: { kind: 'head' },
  };
  const { oid } = await api<GitDevelopmentPreview>(gitUrl + '/preview', 'POST', development);
  const linked = await api<{ session: Session; workspace: GitSessionWorkspace }>(
    gitUrl + '/sessions',
    'POST',
    { ...development, expectedOid: oid },
    201,
  );
  for (const session of [ordinary.session, linked.session, otherSession.session]) {
    const { items } = await api<{ items: Array<{ id: string; effective: string }> }>(
      `/api/skill-inheritance?sessionId=${session.id}`,
    );
    assert.equal(
      items.find((item) => item.id === synced.id)?.effective,
      session.projectId === project.id ? 'manual' : undefined,
    );
  }
  const send = (session: Session, text: string, selection?: Extension, status = 202) =>
    api(
      `/api/sessions/${session.id}/messages`,
      'POST',
      {
        text,
        idempotencyKey: randomUUID(),
        ...(selection
          ? { extensionSelections: [{ id: selection.id, version: selection.version }] }
          : {}),
      },
      status,
    );
  await send(ordinary.session, 'unselected');
  assert.equal(requests.at(-1)?.skills.length, 0);
  await send(ordinary.session, '/sample review');
  await send(linked.session, 'read notes', synced);
  assert.equal(requests.at(-1)?.path, linked.workspace.path);
  for (const run of requests.slice(-2)) {
    assert.match(run.prompt, /Use \[notes\]/);
    assert.equal(run.skills[0]?.version, synced.version);
    assert.equal(readSkillResource(run.skills[0]!, 'references/notes.md'), 'changed reference');
  }
  await send(otherSession.session, 'cross-project', synced, 409);
  const edited = registry.save(
    project.id,
    { version: synced.version, body: 'local edit' },
    synced.id,
  );
  const originalPinnedUpdate = await api<{ error: { code: string } }>(
    endpoint + '/public-import',
    'POST',
    {
      ...input(pre),
      update: update(edited),
    },
    409,
  );
  assert.equal(originalPinnedUpdate.error.code, 'PUBLIC_LOCAL_MODIFIED');
  assert.equal(registry.get(project.id, edited.id).version, edited.version);
  const repeatEdited = await api<{ error: { code: string } }>(
    endpoint + '/public-import',
    'POST',
    input(newer),
    409,
  );
  assert.equal(repeatEdited.error.code, 'PUBLIC_LOCAL_MODIFIED');

  const longLocation =
    'https://raw.githubusercontent.com/sample/skills/main/' + 'segment/'.repeat(35) + 'SKILL.md';
  const long = registry.savePublic(other.id, {
    ...pre,
    location: longLocation,
    package: origin.package,
  }).item;
  const toggled = registry.save(
    other.id,
    { version: long.version, enabled: !long.enabled },
    long.id,
  );
  assert.equal(toggled.enabled, !long.enabled);
});

test('reports GitHub API rate limiting as a retryable source error', async () => {
  await assert.rejects(
    previewPublic(
      repo,
      'skill',
      async () =>
        new Response('', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        }),
    ),
    { code: 'GITHUB_SKILL_RATE_LIMIT', retryable: true },
  );
});

test('repository discovery keeps nested Skills alongside a root manifest', async () => {
  const { request } = fixture();
  const withRoot: typeof fetch = async (input, options) => {
    const url = String(input);
    if (url === raw + '/' + first + '/SKILL.md') return new Response(new Uint8Array(document));
    const response = await request(input, options);
    if (!url.endsWith(firstTree + '?recursive=1')) return response;
    const tree = await response.json();
    return Response.json({
      ...tree,
      tree: [
        ...tree.tree,
        {
          path: 'SKILL.md',
          mode: '100644',
          type: 'blob',
          sha: blob(document),
          size: document.length,
        },
      ],
    });
  };
  const items = await previewPublic(repo, 'skill', withRoot);
  assert.ok(items.some((item) => item.key === 'SKILL.md'));
  assert.ok(items.some((item) => item.key === skillDir + '/SKILL.md'));
});

test('authenticated import restricts the CLI to public repositories and the opted-in account', async () => {
  const seen: string[] = [];
  const fallback: typeof fetch = async (input) => {
    assert.ok(String(input).startsWith(raw));
    return new Response('raw');
  };
  let visibility = 'private';
  let login = 'fixture';
  const invoke = async (endpoint: string) => {
    seen.push(endpoint);
    if (endpoint === '/user') return Response.json({ login });
    if (endpoint === '/repos/sample/skills')
      return Response.json({ visibility, private: visibility === 'private' });
    return new Response('fixture metadata');
  };
  const url = api + '/commits/HEAD';
  await assert.rejects(authenticatedGithubFetch('fixture', fallback, invoke)(url), {
    code: 'GITHUB_PUBLIC_REPO_REQUIRED',
  });
  assert.deepEqual(seen.splice(0), ['/user', '/repos/sample/skills']);
  visibility = 'public';
  const verified = authenticatedGithubFetch('fixture', fallback, invoke);
  await assert.rejects(verified(api + '/issues'), { code: 'PUBLIC_SOURCE_INVALID' });
  await verified(raw + '/main/SKILL.md');
  assert.deepEqual(seen, []);
  await verified(url);
  await verified(api + '/git/trees/' + first + '?recursive=1');
  assert.deepEqual(seen.splice(0), [
    '/user',
    '/repos/sample/skills',
    '/repos/sample/skills/commits/HEAD',
    '/repos/sample/skills/git/trees/' + first + '?recursive=1',
  ]);
  login = 'different-account';
  await assert.rejects(authenticatedGithubFetch('fixture', fallback, invoke)(url), {
    code: 'GITHUB_LOGIN_REQUIRED',
  });
  assert.deepEqual(seen, ['/user']);
});
