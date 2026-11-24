/**
 * @file 验证多提交工作流的 HTTP 接口与真实 Git 索引。
 * @implementation 使用临时仓库、SQLite 和回环网关验证对话增量、模型披露、本地提交权限、逐组预览、幂等及暂存语义。
 * @updated 2026-11-25T01:22:11+08:00
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { z } from 'zod';
import { createApp } from '../server/app.js';
import {
  multiCommitDraft,
  multiCommitPreview,
  multiCommitReceipt,
  multiCommitRevisionResponse,
  multiCommitValidate,
} from '../shared/git-multi-commit.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

test('multi-commit API previews and creates the reviewed staged and unstaged changes exactly once', async () => {
  const base = await mkdtemp(join(tmpdir(), 'atelier-multi-api-'));
  const repo = join(base, 'project');
  const data = join(base, 'data');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(repo, 'a.txt'), 'old a\n');
  await writeFile(join(repo, 'b.txt'), 'old b\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  await writeFile(join(repo, 'a.txt'), 'new a\n');
  git(repo, 'add', 'a.txt');
  await writeFile(join(repo, 'b.txt'), 'new b\n');
  await writeFile(join(repo, '.env'), 'SYNTHETIC_SECRET_DO_NOT_SEND\n');
  for (const [path, field, value] of [
    ['settings.json', 'password', 'SYNTHETIC_CREDENTIAL_123456'],
    ['token.json', 'token', 'SYNTHETIC_TOKEN_123456789'],
    ['secret.json', 'secret', 'SYNTHETIC_SECRET_123456789'],
  ] as const) {
    await writeFile(join(repo, path), JSON.stringify({ [field]: value }) + '\n');
  }
  let gatewayInput = '';
  let revisionOutput: unknown;
  const originalIndex = await readFile(join(repo, '.git/index'));
  const app = await createApp({ root, data });
  const gateway = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      gatewayInput = Buffer.concat(chunks).toString();
      const envelope = JSON.parse(gatewayInput) as {
        messages: { content: string }[];
      };
      const payload = JSON.parse(envelope.messages[0]?.content ?? '{}') as {
        units: { id: string; path: string }[];
      };
      const groups = ['a.txt', 'b.txt'].map((path, index) => ({
        title: index ? 'second' : 'first',
        body: '',
        unitIds: payload.units.filter((unit) => unit.path === path).map((unit) => unit.id),
      }));
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: JSON.stringify(revisionOutput ?? { groups, unassignedUnitIds: [] }),
            },
          ],
        }),
      );
    })().catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  try {
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const gatewayAddress = gateway.address();
    assert.ok(gatewayAddress && typeof gatewayAddress === 'object');
    app.store.setConfig({
      ...app.store.config(),
      gateway: `http://127.0.0.1:${gatewayAddress.port}`,
      managedGateway: false,
      model: 'fixture-multi',
    });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const boot = (await fetch(origin + '/api/bootstrap').then((response) => response.json())) as {
      csrfToken: string;
    };
    async function request(path: string, body: unknown, expected = 200): Promise<unknown> {
      const response = await fetch(origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-atelier-token': boot.csrfToken },
        body: JSON.stringify(body),
      });
      const value: unknown = await response.json();
      assert.equal(response.status, expected, JSON.stringify(value));
      return value;
    }
    const { project } = (await request('/api/projects', { path: repo }, 201)) as {
      project: { id: string };
    };
    const prefix = `/api/projects/${project.id}/git/worktrees/${project.id}`;
    const draft = multiCommitDraft.parse(
      await request(prefix + '/commit-plan', { locale: 'zh-CN', generate: true }),
    );
    assert.equal(draft.suggestionStatus, 'ready');
    assert.equal(draft.groups.length, 2);
    assert.doesNotMatch(
      gatewayInput,
      /SYNTHETIC_SECRET_DO_NOT_SEND|SYNTHETIC_CREDENTIAL_123456|SYNTHETIC_TOKEN_123456789|SYNTHETIC_SECRET_123456789|\.env|settings\.json|token\.json|secret\.json/,
    );
    const restricted = draft.units.filter((unit) =>
      ['.env', 'settings.json', 'token.json', 'secret.json'].includes(unit.path),
    );
    assert.equal(restricted.length, 4);
    assert.equal(restricted.find((unit) => unit.path === '.env')?.reason, 'restrictedPath');
    assert.ok(
      restricted
        .filter((unit) => unit.path !== '.env')
        .every((unit) => unit.credential?.location.kind === 'addition'),
    );
    const a = draft.units.filter((unit) => unit.path === 'a.txt');
    const b = draft.units.filter((unit) => unit.path === 'b.txt');
    assert.ok(a.length && b.length);
    assert.ok(a.every((unit) => unit.layer === 'staged'));
    assert.ok(b.every((unit) => unit.layer === 'unstaged'));
    const plan = {
      version: draft.version,
      groups: draft.groups,
      excludedUnitIds: restricted.map((unit) => unit.id),
    };
    const secret = restricted.find((unit) => unit.path === 'settings.json');
    const firstGroup = plan.groups[0];
    assert.ok(secret && firstGroup);
    const credentialExample = (purpose: string) =>
      ['token', JSON.stringify(`SYNTHETIC_${purpose}_CREDENTIAL_12345`)].join(' = ');
    const revision = {
      ...plan,
      groups: [{ ...firstGroup, body: credentialExample('MESSAGE') }, ...plan.groups.slice(1)],
      locale: 'zh-CN',
      model: 'fixture-revise',
      instruction: '改写第一组标题',
      previousTurns: [
        { instruction: '保留其他部分', note: '' },
        { instruction: credentialExample('HISTORY'), note: '' },
      ],
    };
    revisionOutput = {
      note: '',
      edits: [{ kind: 'message', groupId: firstGroup.id, title: '改写后的标题' }],
    };
    const revised = multiCommitRevisionResponse.parse(
      await request(prefix + '/commit-plan-revise', revision),
    );
    assert.deepEqual(revised.groups[0], { ...revision.groups[0], title: '改写后的标题' });
    assert.deepEqual(revised.excludedUnitIds, plan.excludedUnitIds);
    assert.match(gatewayInput, /fixture-revise/);
    assert.match(gatewayInput, /保留其他部分/);
    assert.doesNotMatch(
      gatewayInput,
      /SYNTHETIC_|\.env|settings\.json|token\.json|secret\.json|\+new a|\+new b/,
    );
    for (const unit of restricted) assert.ok(!gatewayInput.includes(unit.id));
    gatewayInput = '';
    await request(prefix + '/commit-plan-revise', { ...revision, version: 'stale' }, 409);
    await request(
      prefix + '/commit-plan-revise',
      { ...revision, instruction: credentialExample('REVISION') },
      409,
    );
    assert.equal(gatewayInput, '');
    revisionOutput = {
      note: '',
      edits: [{ kind: 'move', groupId: firstGroup.id, unitIds: [secret.id] }],
    };
    const rejected = await request(prefix + '/commit-plan-revise', revision, 409);
    assert.equal(
      z.object({ error: z.object({ code: z.string() }) }).parse(rejected).error.code,
      'GIT_PLAN_REVISION_INVALID',
    );
    assert.deepEqual(await readFile(join(repo, '.git/index')), originalIndex);
    assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), 'initial');
    await request(
      prefix + '/commit-plan-validate',
      {
        ...plan,
        groups: [
          { ...firstGroup, unitIds: [...firstGroup.unitIds, secret.id] },
          ...plan.groups.slice(1),
        ],
        excludedUnitIds: plan.excludedUnitIds.filter((id) => id !== secret.id),
      },
      409,
    );
    const preview = multiCommitPreview.parse(await request(prefix + '/commit-plan-validate', plan));
    assert.match(preview.groups[0]?.files[0]?.text ?? '', /\+new a/);
    assert.match(preview.groups[1]?.files[0]?.text ?? '', /\+new b/);
    assert.deepEqual(await readFile(join(repo, '.git/index')), originalIndex);
    const input = { ...plan, operationId: randomUUID(), digest: preview.digest };
    await request(prefix + '/commit-plan-execute', { ...input, digest: '0'.repeat(64) }, 409);
    assert.deepEqual(await readFile(join(repo, '.git/index')), originalIndex);
    const receipt = multiCommitReceipt.parse(
      await request(prefix + '/commit-plan-execute', input, 201),
    );
    assert.equal(receipt.commits.length, 2);
    assert.equal(git(repo, 'log', '-2', '--format=%s'), 'second\nfirst\n');
    assert.equal(git(repo, 'show', receipt.commits[0] + ':a.txt'), 'new a\n');
    assert.equal(git(repo, 'show', receipt.commits[0] + ':b.txt'), 'old b\n');
    assert.equal(git(repo, 'show', receipt.commits[1] + ':b.txt'), 'new b\n');
    assert.equal(
      git(repo, 'status', '--porcelain'),
      '?? .env\n?? secret.json\n?? settings.json\n?? token.json\n',
    );
    assert.equal(await readFile(join(repo, '.env'), 'utf8'), 'SYNTHETIC_SECRET_DO_NOT_SEND\n');
    assert.deepEqual(
      multiCommitReceipt.parse(await request(prefix + '/commit-plan-execute', input, 201)),
      receipt,
    );
    assert.equal(git(repo, 'log', '-3', '--format=%s'), 'second\nfirst\ninitial\n');
    const pendingResponse = await fetch(origin + prefix + '/commit-plan-pending');
    assert.equal(pendingResponse.status, 200);
    assert.deepEqual(await pendingResponse.json(), { items: [] });
  } finally {
    await app.close();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  }
});

test('same file staged and unstaged changes are previewed and committed in separate layers', async () => {
  const base = await mkdtemp(join(tmpdir(), 'atelier-multi-layers-'));
  const repo = join(base, 'project');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(repo, 'file.txt'), 'HEAD version\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  await writeFile(join(repo, 'file.txt'), 'staged version\n');
  git(repo, 'add', 'file.txt');
  await writeFile(join(repo, 'file.txt'), 'worktree version\n');
  const app = await createApp({ root, data: join(base, 'data') });
  try {
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const boot = (await fetch(origin + '/api/bootstrap').then((response) => response.json())) as {
      csrfToken: string;
    };
    async function post(path: string, body: unknown, expected = 200): Promise<unknown> {
      const response = await fetch(origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-atelier-token': boot.csrfToken },
        body: JSON.stringify(body),
      });
      const value: unknown = await response.json();
      assert.equal(response.status, expected, JSON.stringify(value));
      return value;
    }
    const { project } = (await post('/api/projects', { path: repo }, 201)) as {
      project: { id: string };
    };
    const prefix = `/api/projects/${project.id}/git/worktrees/${project.id}`;
    const draft = multiCommitDraft.parse(
      await post(prefix + '/commit-plan', { locale: 'en', generate: false }),
    );
    const staged = draft.units.filter((unit) => unit.layer === 'staged');
    const unstaged = draft.units.filter((unit) => unit.layer === 'unstaged');
    assert.ok(staged.length && unstaged.length);
    const plan = {
      version: draft.version,
      groups: [
        {
          id: randomUUID(),
          title: 'staged layer',
          body: '',
          unitIds: staged.map((unit) => unit.id),
        },
        {
          id: randomUUID(),
          title: 'workspace layer',
          body: '',
          unitIds: unstaged.map((unit) => unit.id),
        },
      ],
      excludedUnitIds: [],
    };
    const preview = multiCommitPreview.parse(await post(prefix + '/commit-plan-validate', plan));
    assert.match(preview.groups[0]?.files[0]?.text ?? '', /-HEAD version[\s\S]*\+staged version/);
    assert.match(
      preview.groups[1]?.files[0]?.text ?? '',
      /-staged version[\s\S]*\+worktree version/,
    );
    const receipt = multiCommitReceipt.parse(
      await post(
        prefix + '/commit-plan-execute',
        { ...plan, digest: preview.digest, operationId: randomUUID() },
        201,
      ),
    );
    assert.equal(git(repo, 'show', receipt.commits[0] + ':file.txt'), 'staged version\n');
    assert.equal(git(repo, 'show', receipt.commits[1] + ':file.txt'), 'worktree version\n');
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    await app.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('multi-commit drafts bind the selected or default model to its gateway without changing config', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'atelier-multi-model-'));
  const repo = join(base, 'project');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(repo, 'file.txt'), 'before\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  await writeFile(join(repo, 'file.txt'), 'after\n');
  await writeFile(join(repo, '.env'), 'SYNTHETIC_MODEL_SECRET_DO_NOT_SEND\n');
  const originalHead = git(repo, 'rev-parse', 'HEAD');
  const originalIndex = await readFile(join(repo, '.git/index'));
  const requests: { source: string; method: string | undefined; url: string | undefined }[] = [];
  const inference: {
    source: string;
    model: string;
    input: string;
    outputConfig?: { effort: string };
  }[] = [];
  let magpieDown = false;
  const gateway = (source: 'shunt' | 'magpie') =>
    createServer((request, response) => {
      requests.push({ source, method: request.method, url: request.url });
      void (async () => {
        if (source === 'magpie' && magpieDown) {
          response.writeHead(503).end();
          return;
        }
        if (request.method !== 'POST' || request.url !== '/v1/messages') {
          response.setHeader('content-type', 'application/json');
          response.end('{}');
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = Buffer.concat(chunks).toString();
        const envelope = z
          .object({
            model: z.string(),
            output_config: z.strictObject({ effort: z.string() }).optional(),
            messages: z.array(z.object({ content: z.string() })),
          })
          .parse(JSON.parse(input));
        inference.push({
          source,
          model: envelope.model,
          input,
          outputConfig: envelope.output_config,
        });
        const payload = z
          .object({ units: z.array(z.object({ id: z.string() })) })
          .parse(JSON.parse(envelope.messages[0]?.content ?? '{}'));
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            stop_reason: 'end_turn',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  groups: [
                    { title: 'fixture', body: '', unitIds: payload.units.map(({ id }) => id) },
                  ],
                  unassignedUnitIds: [],
                }),
              },
            ],
          }),
        );
      })().catch(() => {
        response.writeHead(500).end();
      });
    });
  const shunt = gateway('shunt');
  const magpie = gateway('magpie');
  async function listen(server: ReturnType<typeof createServer>) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  }
  const shuntOrigin = await listen(shunt);
  const magpieOrigin = await listen(magpie);
  let app = await createApp({ root, data: join(base, 'data'), magpie: magpieOrigin });
  try {
    app.store.setConfig({
      ...app.store.config(),
      gateway: shuntOrigin,
      managedGateway: false,
      magpieEnabled: true,
      model: 'fixture-default',
      effort: 'max',
    });
    let origin = await listen(app.server);
    let csrfToken = z
      .object({ csrfToken: z.string() })
      .parse(await fetch(origin + '/api/bootstrap').then((response) => response.json())).csrfToken;
    const projectResponse = await fetch(origin + '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-atelier-token': csrfToken },
      body: JSON.stringify({ path: repo }),
    });
    assert.equal(projectResponse.status, 201);
    const { project } = z
      .object({ project: z.object({ id: z.string() }) })
      .parse(await projectResponse.json());
    const path = `/api/projects/${project.id}/git/worktrees/${project.id}/commit-plan`;
    async function post(body: unknown, expected = 200): Promise<unknown> {
      const savedConfig = app.store.config();
      const response = await fetch(origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-atelier-token': csrfToken },
        body: JSON.stringify(body),
      });
      const value: unknown = await response.json();
      assert.equal(response.status, expected, JSON.stringify(value));
      assert.deepEqual(app.store.config(), savedConfig, 'draft requests preserve global config');
      return value;
    }
    async function draft(model?: string, generate = true) {
      return multiCommitDraft.parse(
        await post({ locale: 'en', generate, ...(model === undefined ? {} : { model }) }),
      );
    }
    async function error(model: string, code: string, status: number) {
      const before = requests.length;
      const value = z
        .object({ error: z.object({ code: z.string() }) })
        .parse(await post({ locale: 'en', generate: true, model }, status));
      assert.equal(value.error.code, code);
      assert.equal(requests.length, before, 'rejected models never reach either gateway');
    }
    async function selected(model: string | undefined, source: string, actualModel: string) {
      const before = inference.length;
      const value = await draft(model);
      assert.equal(value.suggestionStatus, 'ready');
      assert.equal(
        value.analysisModel,
        source === 'magpie' ? `magpie:${actualModel}` : actualModel,
      );
      assert.equal(inference.length, before + 1);
      assert.equal(inference.at(-1)?.source, source);
      assert.equal(inference.at(-1)?.model, actualModel);
      assert.equal(inference.at(-1)?.outputConfig, undefined, 'chat effort is not inherited');
      const { analysisModel: _analysisModel, ...legacy } = value;
      assert.equal(multiCommitDraft.parse(legacy).analysisModel, undefined);
    }

    await t.test(
      'Shunt defaults and per-request picks reach the actual selected model',
      async () => {
        await selected(undefined, 'shunt', 'fixture-default');
        await selected('  fixture-selected  ', 'shunt', 'fixture-selected');
        await selected('magpie:fixture/shared', 'magpie', 'fixture/shared');
      },
    );
    await t.test(
      'explicit effort reaches either gateway and changing it rejects resume',
      async () => {
        for (const model of ['fixture-selected', 'magpie:fixture/shared']) {
          const before = inference.length;
          const value = multiCommitDraft.parse(
            await post({ locale: 'en', generate: true, model, effort: 'xhigh' }),
          );
          assert.equal(value.suggestionStatus, 'ready');
          assert.deepEqual(inference.at(-1)?.outputConfig, { effort: 'xhigh' });
          assert.equal(inference.length, before + 1);
          assert.ok(value.analysis);
          for (const effort of [undefined, 'low']) {
            const rejected = z.object({ error: z.object({ code: z.string() }) }).parse(
              await post(
                {
                  locale: 'en',
                  generate: true,
                  model,
                  effort,
                  analysisId: value.analysis.id,
                  resume: true,
                },
                409,
              ),
            );
            assert.equal(rejected.error.code, 'GIT_PLAN_ANALYSIS_STALE');
          }
          const retained = multiCommitDraft.parse(
            await post({
              locale: 'en',
              generate: false,
              model,
              effort: 'xhigh',
              analysisId: value.analysis.id,
              resume: true,
            }),
          );
          assert.deepEqual(retained.groups, value.groups);
          assert.equal(inference.length, before + 1);
        }
      },
    );
    await t.test(
      'a Shunt pick overrides a Magpie default and omitted picks keep that default',
      async () => {
        app.store.setConfig({ ...app.store.config(), model: 'magpie:fixture/default' });
        await selected(undefined, 'magpie', 'fixture/default');
        await selected('fixture-selected', 'shunt', 'fixture-selected');
      },
    );
    await t.test('generation disabled makes no gateway request for either source', async () => {
      for (const model of [undefined, 'fixture-selected', 'magpie:fixture/shared']) {
        const before = requests.length;
        const value = await draft(model, false);
        assert.equal(value.suggestionStatus, 'manual');
        assert.equal(value.suggestionReason, 'manual');
        assert.equal(value.analysisModel, undefined);
        assert.equal(requests.length, before);
      }
    });
    await t.test(
      'invalid model IDs and client gateway overrides are rejected before inference',
      async () => {
        const before = requests.length;
        for (const model of ['', 'two models', 'x'.repeat(201), null, 42]) {
          await post({ locale: 'en', generate: true, model }, 400);
        }
        for (const field of ['gateway', 'managedGateway', 'magpie', 'magpieEnabled']) {
          await post(
            { locale: 'en', generate: true, model: 'fixture-selected', [field]: shuntOrigin },
            400,
          );
        }
        assert.equal(requests.length, before);
        await error('magpie:', 'MAGPIE_UNAVAILABLE', 400);
      },
    );
    await t.test(
      'disabled Magpie rejects explicit generation and permits manual or Shunt use',
      async () => {
        app.store.setConfig({ ...app.store.config(), magpieEnabled: false });
        await error('magpie:fixture/shared', 'MAGPIE_DISABLED', 409);
        const before = requests.length;
        const unavailable = await draft(undefined);
        assert.equal(unavailable.suggestionReason, 'unavailable');
        assert.equal(unavailable.analysisModel, undefined);
        assert.equal((await draft('magpie:fixture/shared', false)).suggestionReason, 'manual');
        assert.equal(requests.length, before);
        await selected('fixture-selected', 'shunt', 'fixture-selected');
      },
    );
    await t.test(
      'a failing Magpie gateway keeps the existing manual fallback without Shunt fallback',
      async () => {
        app.store.setConfig({ ...app.store.config(), magpieEnabled: true });
        magpieDown = true;
        const before = requests.length;
        const value = await draft('magpie:fixture/shared');
        assert.equal(value.suggestionStatus, 'partial');
        assert.equal(value.suggestionReason, 'http');
        assert.equal(value.analysisModel, 'magpie:fixture/shared');
        assert.deepEqual(requests.slice(before), [
          { source: 'magpie', method: 'POST', url: '/v1/messages' },
        ]);
        assert.ok(value.analysis);
        const analysisId = value.analysis.id;
        const retained = multiCommitDraft.parse(
          await post({
            locale: 'en',
            generate: false,
            model: 'magpie:fixture/shared',
            analysisId,
            resume: true,
          }),
        );
        assert.equal(retained.suggestionReason, 'http');
        assert.deepEqual(retained.groups, value.groups);
        assert.equal(requests.length, before + 1, 'passive recovery does not request a model');
        magpieDown = false;
        const resumed = multiCommitDraft.parse(
          await post({
            locale: 'en',
            generate: true,
            model: 'magpie:fixture/shared',
            analysisId,
            resume: true,
          }),
        );
        assert.equal(resumed.suggestionStatus, 'ready');
        assert.equal(resumed.analysis?.id, analysisId);
        const inferenceCount = inference.length;
        const repeated = multiCommitDraft.parse(
          await post({ locale: 'en', generate: true, model: 'magpie:fixture/shared', analysisId }),
        );
        assert.deepEqual(repeated.groups, resumed.groups);
        assert.equal(
          inference.length,
          inferenceCount,
          'repeating a completed request ID is idempotent',
        );
        const changedModel = z
          .object({ error: z.object({ code: z.string() }) })
          .parse(
            await post(
              { locale: 'en', generate: true, model: 'fixture-selected', analysisId, resume: true },
              409,
            ),
          );
        assert.equal(changedModel.error.code, 'GIT_PLAN_ANALYSIS_STALE');
        const missing = z.object({ error: z.object({ code: z.string() }) }).parse(
          await post(
            {
              locale: 'en',
              generate: false,
              model: 'magpie:fixture/shared',
              analysisId: randomUUID(),
              resume: true,
            },
            410,
          ),
        );
        assert.equal(missing.error.code, 'GIT_PLAN_ANALYSIS_EXPIRED');
        await writeFile(join(repo, 'file.txt'), 'changed snapshot\n');
        try {
          const stale = z.object({ error: z.object({ code: z.string() }) }).parse(
            await post(
              {
                locale: 'en',
                generate: false,
                model: 'magpie:fixture/shared',
                analysisId,
                resume: true,
              },
              409,
            ),
          );
          assert.equal(stale.error.code, 'GIT_PLAN_ANALYSIS_STALE');
        } finally {
          await writeFile(join(repo, 'file.txt'), 'after\n');
        }
        assert.equal(
          inference.length,
          inferenceCount,
          'rejected recovery requests never invoke the model',
        );
      },
    );
    await t.test(
      'an unconfigured Magpie origin returns the existing unavailable error',
      async () => {
        await app.close();
        app = await createApp({ root, data: join(base, 'data') });
        origin = await listen(app.server);
        csrfToken = z
          .object({ csrfToken: z.string() })
          .parse(
            await fetch(origin + '/api/bootstrap').then((response) => response.json()),
          ).csrfToken;
        await error('magpie:fixture/shared', 'MAGPIE_UNAVAILABLE', 400);
        const before = requests.length;
        assert.equal((await draft('magpie:fixture/shared', false)).suggestionStatus, 'manual');
        assert.equal(requests.length, before);
        await selected('fixture-selected', 'shunt', 'fixture-selected');
      },
    );
    await t.test(
      'a draft with no analyzable changes omits analysisModel and sends no request',
      async () => {
        await writeFile(join(repo, 'file.txt'), 'before\n');
        try {
          const before = requests.length;
          const value = await draft('fixture-selected');
          assert.equal(value.suggestionStatus, 'manual');
          assert.equal(value.analysisModel, undefined);
          assert.equal(requests.length, before);
        } finally {
          await writeFile(join(repo, 'file.txt'), 'after\n');
        }
      },
    );
    for (const request of inference)
      assert.doesNotMatch(request.input, /SYNTHETIC_MODEL_SECRET_DO_NOT_SEND|\.env/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), originalHead);
    assert.deepEqual(await readFile(join(repo, '.git/index')), originalIndex);
    assert.equal(await readFile(join(repo, 'file.txt'), 'utf8'), 'after\n');
  } finally {
    await app.close();
    await Promise.all([
      new Promise<void>((resolve) => shunt.close(() => resolve())),
      new Promise<void>((resolve) => magpie.close(() => resolve())),
    ]);
    await rm(base, { recursive: true, force: true });
  }
});

test('credential provenance gates model disclosure and actual commits independently', async () => {
  const base = await mkdtemp(join(tmpdir(), 'atelier-commit-privacy-'));
  const repo = join(base, 'project');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  const write = (path: string, content: string | Buffer) => writeFile(join(repo, path), content);
  const gap = Array.from({ length: 14 }, (_, index) => '// filler ' + index + '\n').join('');
  const providerSample = (position: string) =>
    ['ghp', position, 'SYNTHETIC', '1234567890'].join('_');
  const oldSecret = providerSample('OLD');
  const stagedSecret = randomUUID();
  const addedSecret = randomUUID();
  const secretPath = providerSample('PATH') + '.txt';
  const binaryMarker = providerSample('BINARY');
  const binary = Buffer.from(`\0${binaryMarker}\0`);
  const dual = (mode: number, far: number) =>
    `const mode = ${mode};\nconst token = "${oldSecret}";\n${gap}const far = ${far};\n`;
  await write('dual.ts', dual(0, 0));
  await write('cleanup.ts', `const token = "${oldSecret}";\n`);
  await write('mixed.ts', `const nearby = 0;\n${gap}const far = 0;\n`);
  await write('blocked.ts', `const token = currentToken;\n${gap}const flag = 0;\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  await write('dual.ts', dual(1, 0));
  const introduced = `const token = "${stagedSecret}";\n${gap}`;
  await write('blocked.ts', introduced + 'const flag = 0;\n');
  git(repo, 'add', 'dual.ts', 'blocked.ts');
  await write('dual.ts', dual(1, 1));
  await write('blocked.ts', introduced + 'const flag = 1;\n');
  await write('cleanup.ts', "const token = triggerAt('please check @styl', 18, 18)!;\n");
  await write(
    'mixed.ts',
    `const nearby = 1;\n${gap}const far = 0;\nconst apiKey =\n  "${addedSecret}";\n`,
  );
  await write('picker-model.test.ts', 'const token = atEnd(text);\n');
  await write(secretPath, 'a filename can contain a credential\n');
  await write('binary.bin', binary);
  const originalIndex = await readFile(join(repo, '.git/index'));
  const originalHead = git(repo, 'rev-parse', 'HEAD');
  const requests: string[] = [];
  const gateway = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/messages') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = Buffer.concat(chunks).toString();
      requests.push(request);
      const envelope = z
        .object({ messages: z.array(z.object({ content: z.string() })) })
        .parse(JSON.parse(request));
      const { units } = z
        .object({ units: z.array(z.object({ id: z.string() })) })
        .parse(JSON.parse(envelope.messages[0]?.content ?? '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                groups: [{ title: 'safe changes', body: '', unitIds: units.map(({ id }) => id) }],
                unassignedUnitIds: [],
              }),
            },
          ],
        }),
      );
    } catch {
      res.writeHead(500).end();
    }
  });
  const app = await createApp({ root, data: join(base, 'data') });
  try {
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const gatewayAddress = gateway.address();
    assert.ok(gatewayAddress && typeof gatewayAddress === 'object');
    app.store.setConfig({
      ...app.store.config(),
      gateway: `http://127.0.0.1:${gatewayAddress.port}`,
      managedGateway: false,
      model: 'fixture-privacy',
    });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const { csrfToken } = z
      .object({ csrfToken: z.string() })
      .parse(await fetch(origin + '/api/bootstrap').then((res) => res.json()));
    async function post(path: string, body: unknown, status = 200): Promise<unknown> {
      const res = await fetch(origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-atelier-token': csrfToken },
        body: JSON.stringify(body),
      });
      const value: unknown = await res.json();
      assert.equal(res.status, status, JSON.stringify(value));
      return value;
    }
    const { project } = z
      .object({ project: z.object({ id: z.uuid() }) })
      .parse(await post('/api/projects', { path: repo }, 201));
    const prefix = `/api/projects/${project.id}/git/worktrees/${project.id}`;
    const local = multiCommitDraft.parse(
      await post(prefix + '/commit-plan', { locale: 'en', generate: false }),
    );
    assert.equal(requests.length, 0);
    const error = z.object({ error: z.object({ code: z.string() }) });
    assert.equal(
      error.parse(
        await post(
          prefix + '/commit-plan',
          {
            locale: 'en',
            generate: true,
            version: 'stale',
          },
          409,
        ),
      ).error.code,
      'GIT_PLAN_STALE',
    );
    assert.equal(requests.length, 0);
    const planned = multiCommitDraft.parse(
      await post(prefix + '/commit-plan', {
        locale: 'en',
        generate: true,
        version: local.version,
      }),
    );
    assert.equal(planned.suggestionStatus, 'ready');
    assert.equal(requests.length, 1);
    const payload = requests.join('');
    for (const withheld of [
      oldSecret,
      stagedSecret,
      addedSecret,
      secretPath,
      binaryMarker,
      'cleanup.ts',
      'blocked.ts',
      'dual.ts',
    ])
      assert.ok(!payload.includes(withheld), 'withheld ' + withheld);
    assert.match(payload, /atEnd\(text\)/);
    assert.ok(payload.includes('binary.bin'));
    assert.equal(
      planned.units.some((unit) => unit.diff !== undefined),
      false,
    );
    const byPath = (path: string) => planned.units.filter((unit) => unit.path === path);
    const [staged] = byPath('dual.ts').filter((unit) => unit.layer === 'staged');
    const [workspace] = byPath('dual.ts').filter((unit) => unit.layer === 'unstaged');
    const [cleanup] = byPath('cleanup.ts');
    const [named] = byPath(secretPath);
    const addition = byPath('mixed.ts').find((unit) => unit.credential);
    const safeHunk = byPath('mixed.ts').find((unit) => !unit.credential);
    assert.ok(staged && workspace && cleanup && addition && safeHunk && named);
    assert.deepEqual(named.credential?.location, { kind: 'path' });
    assert.deepEqual(staged.credential, { rule: 'format', location: { kind: 'context', line: 2 } });
    assert.deepEqual(cleanup.credential, {
      rule: 'format',
      location: { kind: 'deletion', line: 1 },
    });
    assert.equal(addition.credential?.location.kind, 'addition');
    assert.deepEqual(workspace.dependsOn, [staged.id]);
    assert.equal(workspace.credential, undefined);
    assert.ok(planned.modelCandidateIds.includes(safeHunk.id));
    assert.ok(!planned.modelCandidateIds.includes(workspace.id));
    assert.ok(!planned.modelCandidateIds.includes(addition.id));
    assert.ok(!payload.includes(addition.id));
    const plan = multiCommitValidate.parse({
      version: local.version,
      groups: [
        ...planned.groups,
        { id: randomUUID(), title: 'local edits', body: '', unitIds: [staged.id, cleanup.id] },
        { id: randomUUID(), title: 'workspace follow-up', body: '', unitIds: [workspace.id] },
      ],
      excludedUnitIds: [addition.id, named.id, ...byPath('blocked.ts').map((unit) => unit.id)],
    });
    const first = plan.groups[0];
    assert.ok(first);
    const unsafe = multiCommitValidate.parse({
      ...plan,
      groups: [{ ...first, unitIds: [...first.unitIds, addition.id] }, ...plan.groups.slice(1)],
      excludedUnitIds: plan.excludedUnitIds.filter((id) => id !== addition.id),
    });
    assert.equal(
      error.parse(await post(prefix + '/commit-plan-validate', unsafe, 409)).error.code,
      'GIT_PLAN_CREDENTIAL',
    );
    await post(prefix + '/commit-plan-validate', { ...unsafe, allowCredential: true }, 400);
    assert.equal(
      error.parse(
        await post(
          prefix + '/commit-plan-execute',
          {
            ...unsafe,
            digest: createHash('sha256').update(JSON.stringify(unsafe)).digest('hex'),
            operationId: randomUUID(),
          },
          409,
        ),
      ).error.code,
      'GIT_PLAN_CREDENTIAL',
    );
    assert.deepEqual(await readFile(join(repo, '.git/index')), originalIndex);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), originalHead);
    const preview = multiCommitPreview.parse(await post(prefix + '/commit-plan-validate', plan));
    assert.ok(preview.groups[0]?.files.find(({ path }) => path === 'binary.bin')?.binary);
    assert.ok(
      preview.groups[1]?.files
        .find(({ path }) => path === 'cleanup.ts')
        ?.text.includes(`-const token = "${oldSecret}"`),
    );
    const receipt = multiCommitReceipt.parse(
      await post(
        prefix + '/commit-plan-execute',
        {
          ...plan,
          digest: preview.digest,
          operationId: randomUUID(),
        },
        201,
      ),
    );
    assert.equal(receipt.commits.length, 3);
    assert.equal(requests.length, 1);
    assert.equal(git(repo, 'show', 'HEAD:dual.ts'), dual(1, 1));
    assert.equal(
      git(repo, 'show', 'HEAD:cleanup.ts'),
      "const token = triggerAt('please check @styl', 18, 18)!;\n",
    );
    assert.equal(git(repo, 'show', 'HEAD:binary.bin'), binary.toString());
    assert.match(git(repo, 'show', 'HEAD:mixed.ts'), /nearby = 1/);
    assert.doesNotMatch(git(repo, 'show', 'HEAD:mixed.ts'), /apiKey/);
    assert.match(git(repo, 'diff', '--', 'mixed.ts'), /apiKey/);
    assert.ok(git(repo, 'diff', '--cached', '--', 'blocked.ts').includes(stagedSecret));
  } finally {
    await app.close();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  }
});
