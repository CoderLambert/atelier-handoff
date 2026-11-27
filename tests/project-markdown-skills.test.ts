/**
 * @file 验证受控项目 Markdown Skill 的发现、挂载和运行范围。
 * @implementation 使用隔离文件系统、SQLite 和真实 SDK 的回环模型替身验证安全边界。
 * @updated 2026-11-27T02:25:28+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentRunner } from '../server/agent.js';
import { FileRecords } from '../server/artifacts.js';
import { discoverProjectMarkdownSkills } from '../server/local-skill-catalog.js';
import { PermissionService } from '../server/permissions.js';
import { mountLocalRunSkills, sdkSkillName } from '../server/run-skills.js';
import { applySkillScope, resolveSkillSelections, SkillInheritance } from '../server/skill-inheritance.js';
import { Store } from '../server/store.js';
import { emptyDraft, now } from '../shared/types.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

const linux = { skip: process.platform !== 'linux' };
const model = 'fixture-project-markdown';
const prompt = 'Check the project Markdown fixture.';
const description = 'PROJECT_MARKDOWN_DESCRIPTION';
const marker = 'PROJECT_MARKDOWN_BODY';
const canonicalSkill = 'workspace-skills:notes';
const document = `---\nname: display-notes\ndescription: ${description}\nmodel: untrusted-model\n---\n${marker} $ARGUMENTS\n`;

function catalog(root: string) {
  return join(root, '.claude', 'skills');
}

async function install(root: string, slug: string, body = document) {
  const directory = join(catalog(root), slug);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), body);
  return directory;
}

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'atelier-project-markdown-'));
  const store = new Store(join(base, 'data'));
  t.after(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  const directory = join(base, 'project');
  const home = join(base, 'home');
  const project = store.put('projects', {
    id: randomUUID(), name: 'Markdown fixture', path: directory, branch: '', available: true, createdAt: now(),
  });
  const session = store.put('sessions', {
    id: randomUUID(), projectId: project.id, title: 'Markdown fixture', status: 'active', sdkSessionId: null,
    draft: emptyDraft(), createdAt: now(), updatedAt: now(),
  });
  const inheritance = new SkillInheritance(store.skillInheritance, home);
  const context = { directory, projectId: project.id, sessionId: session.id, native: false, workspaceAutomatic: true };
  const bundle = { prompt, used: [], mcp: [] };
  return { base, directory, home, project, session, store, inheritance, context, bundle };
}

test('strict project discovery skips symlinks at all levels, hardlinks, and non-text/non-regular files', linux, async (t) => {
  const { base, directory } = await fixture(t);
  const external = await install(join(base, 'outside'), 'external');
  const valid = await install(directory, 'notes');
  await symlink(external, join(catalog(directory), 'linked-directory'), 'dir');
  for (const slug of ['symlink', 'hardlink', 'directory', 'binary', 'bad-utf8', 'oversized', '@bad'])
    await mkdir(join(catalog(directory), slug));
  const file = (slug: string) => join(catalog(directory), slug, 'SKILL.md');
  await symlink(join(external, 'SKILL.md'), file('symlink'));
  await link(join(external, 'SKILL.md'), file('hardlink'));
  await mkdir(file('directory'));
  await writeFile(file('binary'), `${document}\0`);
  await writeFile(file('bad-utf8'), Buffer.from([0xc0, 0x80]));
  await writeFile(file('oversized'), 'x'.repeat(256 * 1024 + 1));
  await writeFile(file('@bad'), document);
  assert.deepEqual(discoverProjectMarkdownSkills(directory).map(({ slug }) => slug), ['notes']);
  const rootLink = join(base, 'project-link');
  await symlink(directory, rootLink, 'dir');
  assert.deepEqual(discoverProjectMarkdownSkills(rootLink), []);
  await rename(catalog(directory), join(directory, 'saved-skills'));
  await symlink(join(directory, 'saved-skills'), catalog(directory), 'dir');
  assert.deepEqual(discoverProjectMarkdownSkills(directory), []);
  await rename(join(directory, '.claude'), join(directory, 'saved-claude'));
  await symlink(join(directory, 'saved-claude'), join(directory, '.claude'), 'dir');
  assert.deepEqual(discoverProjectMarkdownSkills(directory), []);
  assert.ok(valid.endsWith('/notes'));
});

test('inheritance gates host and unsafe Markdown; automatic mount is a text-only snapshot and manual uses only the body', linux, async (t) => {
  const { base, directory, home, store, inheritance, context, bundle } = await fixture(t);
  const notes = await install(directory, 'notes');
  await writeFile(join(notes, 'attachment.txt'), 'not part of the snapshot');
  await install(directory, 'dynamic', 'Inline text!`echo marker`');
  await install(directory, 'dynamic-fence', '```!\necho marker\n```');
  await install(directory, 'hooked', '---\nhooks: {}\n---\nMarkdown');
  await install(directory, 'resource', '[Notes](references/details.md)');
  await install(directory, 'invalid', '---\nmissing closing marker\nMarkdown');
  await install(directory, 'manual', '---\ndisable-model-invocation: true\n---\nManual only');
  await install(directory, 'model-only', '---\nuser-invocable: false\n---\nModel only');
  await install(home, 'host-notes');
  const host = inheritance.snapshot({ native: false }).view.items[0];
  assert.ok(host);
  store.skillInheritance.setGlobal(true);
  store.skillInheritance.setHostMode(host.id, 'auto');
  assert.equal(inheritance.snapshot(context).view.items.find(({ id }) => id === host.id)?.reason, 'not-native');
  assert.equal(inheritance.snapshot(context, true).local.has(host.id), false);
  assert.equal(inheritance.snapshot({ ...context, native: true }, true).local.has(host.id), true);
  assert.equal(inheritance.snapshot({ ...context, workspaceAutomatic: false }, true).local.size, 0);
  assert.equal(inheritance.snapshot({ ...context, boundAuto: new Set() }, true).local.size, 0);
  assert.deepEqual(resolveSkillSelections(inheritance.snapshot(context, true), [host]).project, [host]);
  const snapshot = inheritance.snapshot(context, true);
  const modes = Object.fromEntries(snapshot.view.items.map(({ name, effective }) => [name, effective]));
  assert.deepEqual(modes, {
    dynamic: 'off', 'dynamic-fence': 'off', hooked: 'off', invalid: 'off', manual: 'manual', 'model-only': 'auto',
    'display-notes': 'auto', resource: 'off',
  });
  const item = snapshot.view.items.find(({ name }) => name === 'display-notes');
  assert.ok(item);
  const selected = resolveSkillSelections(snapshot, [item]).local;
  assert.throws(() => resolveSkillSelections(snapshot, [{ ...item, version: item.version + 1 }]));
  const manual = applySkillScope(snapshot, bundle, [], selected, prompt, new Set([item.id]));
  assert.deepEqual(manual.skills, []);
  assert.equal(manual.used[0]?.source, 'workspace');
  assert.match(manual.prompt, /仅 Markdown 正文，不提供附属文件/u);
  assert.match(manual.prompt, /PROJECT_MARKDOWN_BODY Check the project Markdown fixture\./u);
  assert.ok(!manual.prompt.includes(notes));

  const scoped = applySkillScope(snapshot, bundle, [], [], prompt, new Set([item.id]));
  assert.deepEqual(scoped.skills.map(sdkSkillName), [canonicalSkill]);
  store.skillInheritance.setSessionMode(context.sessionId, item.id, 'off');
  assert.deepEqual(applySkillScope(inheritance.snapshot(context, true), bundle, [], [], prompt, new Set([item.id])).skills, []);
  // Mount from captured text, not the project path or its new contents.
  await rm(notes, { recursive: true });
  const sdk = join(base, 'sdk');
  await mkdir(sdk);
  const [plugin] = await mountLocalRunSkills(sdk, scoped.skills, false);
  assert.ok(plugin);
  const mounted = join(plugin, 'skills', 'notes');
  assert.deepEqual(await readdir(mounted), ['SKILL.md']);
  assert.equal(await readFile(join(mounted, 'SKILL.md'), 'utf8'),
    `---\nname: notes\ndescription: "${description}"\nuser-invocable: false\n---\n\n${marker} $ARGUMENTS\n`);
});

test('locked SDK exposes only the exact project Skill to the parent, never to the child', { ...linux, timeout: 30_000 }, async (t) => {
  const { directory, project, session, store, inheritance, context, bundle } = await fixture(t);
  await install(directory, 'notes');
  await install(directory, 'unlisted', '---\ndescription: UNLISTED_MARKER\n---\nUnlisted body');
  const snapshot = inheritance.snapshot(context, true);
  const notes = snapshot.view.items.find(({ name }) => name === 'display-notes');
  assert.ok(notes);
  const { skills } = applySkillScope(snapshot, bundle, [], [], prompt, new Set([notes.id]));
  const main: string[] = [];
  const child: string[] = [];
  const gateway = createServer(async (req, res) => {
    if (!req.url?.startsWith('/v1/messages')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const isParent = body.includes(prompt);
    (isParent ? main : child).push(body);
    const skillCall = (id: string, skill: string) => ({ name: 'Skill', id: `toolu_${id}`, input: { skill } });
    if (!isParent) {
      sendModelReply(res, model, child.length === 1 ? [skillCall('child_notes', canonicalSkill)] : 'Child done');
    } else if (main.length === 1) {
      sendModelReply(res, model, [
        skillCall('alias_notes', 'notes'),
        skillCall('unlisted', 'workspace-skills:unlisted'),
        skillCall('canonical_notes', canonicalSkill),
      ]);
    } else if (main.length === 2) {
      sendModelReply(res, model, [{
        name: 'Agent', id: 'toolu_markdown_child', input: {
          description: 'Review skill isolation', prompt: 'CHILD_SCOPE_FIXTURE', subagent_type: 'atelier-explore',
        },
      }]);
    } else sendModelReply(res, model, 'Parent done');
  });
  t.after(() => {
    gateway.closeAllConnections();
    return new Promise<void>((resolve) => gateway.close(() => resolve()));
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const address = gateway.address();
  assert.ok(address && typeof address === 'object');
  const runner = new AgentRunner(store, new PermissionService(store), new FileRecords(store));
  const run = store.put('runs', {
    id: randomUUID(), projectId: project.id, sessionId: session.id, prompt, mode: 'edit',
    executor: 'project-v1', approvalMode: 'automatic', status: 'queued', createdAt: now(), startedAt: null,
    endedAt: null, reason: null, error: null, retryOf: null, contextPaths: [], attachmentIds: [], plan: [], usage: null,
    config: { gateway: `http://127.0.0.1:${address.port}`, model, maxTurns: 8, timeoutMs: 20_000, limitExecution: true },
  });
  await runner.start(run, prompt, [], skills);
  const finished = store.get('runs', run.id);
  const { events } = store.runHistory(run.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.ok(main[0]?.includes(description));
  assert.ok(main[0]?.includes(canonicalSkill));
  assert.ok(!main[0]?.includes(marker));
  assert.ok(main.every((request) => !request.includes('UNLISTED_MARKER')));
  assert.ok(main.slice(1).some((request) => request.includes(marker)));
  assert.ok(child[0]?.includes('CHILD_SCOPE_FIXTURE'), 'SDK executed a child query');
  for (const [index, request] of child.entries()) {
    const toolNames = JSON.parse(request).tools?.map((tool: { name?: string }) => tool.name);
    assert.ok(!request.includes(description) && !request.includes(marker) && !toolNames?.includes('Skill'),
      JSON.stringify({ index, description: request.includes(description), marker: request.includes(marker), toolNames }));
  }
  assert.ok(events.some(({ type }) => type === 'skills.discovered'));
  const invoked = events.filter(({ type }) => type === 'skill.invoked');
  assert.deepEqual(invoked.map(({ payload }) => payload.extensionId), [notes.id]);
  assert.ok(events.some(({ type, payload }) => type === 'tool.blocked' && String(payload.toolCallId).endsWith(':toolu_alias_notes')));
});
