import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  BetaContentBlockParam,
  BetaRawMessageStreamEvent,
  BetaToolResultBlockParam,
  MessageCreateParamsStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';
import { AgentRunner } from '../server/agent.js';
import { FileRecords } from '../server/artifacts.js';
import { ProjectExtensions } from '../server/extensions.js';
import { PermissionService } from '../server/permissions.js';
import { selectRunSkills } from '../server/run-skills.js';
import { Store } from '../server/store.js';
import { emptyDraft, now, type Run } from '../shared/types.js';

const model = 'sdk-offline-fixture';
const skillName = 'teapot-audit';
const qualifiedSkillName = `atelier-skills:${skillName}`;
const description = 'Use when asked to audit the porcelain teapot fixture.';
const bodyMarker = 'SDK_SKILL_BODY_VISIBLE_ONLY_AFTER_INVOCATION_7c62b8';
const skillBody = `${bodyMarker}\nInspect the teapot handle, lid, and spout; report all three.`;
const prompt = 'Audit the porcelain teapot fixture using the applicable installed skill.';
const toolUseId = 'toolu_offline_native_skill';
const answer = 'OFFLINE_NATIVE_SKILL_COMPLETED';

// Exercise the bundled CLI's real SSE parser and native Skill implementation.
// Only the model transport is replaced; no SDK, tool, hook, or runner is mocked.
function streamMessage(res: ServerResponse, invokeSkill: boolean) {
  const events: BetaRawMessageStreamEvent[] = [
    {
      type: 'message_start',
      message: {
        id: `msg_offline_${invokeSkill ? 'skill' : 'answer'}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        container: null,
        context_management: null,
        diagnostics: null,
        stop_details: null,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: null,
          fallback_credit: null,
          inference_geo: null,
          iterations: null,
          output_tokens_details: null,
          server_tool_use: null,
          service_tier: 'standard',
          speed: 'standard',
        },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: invokeSkill
        ? { type: 'tool_use', id: toolUseId, name: 'Skill', input: {} }
        : { type: 'text', text: '', citations: null },
    },
    ...(invokeSkill
      ? ([
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"skill":' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(qualifiedSkillName) + '}',
            },
          },
        ] satisfies BetaRawMessageStreamEvent[])
      : ([
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: answer },
          },
        ] satisfies BetaRawMessageStreamEvent[])),
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      context_management: null,
      delta: {
        stop_reason: invokeSkill ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        container: null,
        stop_details: null,
      },
      usage: {
        output_tokens: 8,
        input_tokens: 12,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        fallback_credit: null,
        iterations: null,
        output_tokens_details: null,
        server_tool_use: null,
      },
    },
    { type: 'message_stop' },
  ];
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'request-id': `req_offline_${invokeSkill ? 'skill' : 'answer'}`,
  });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

test(
  'offline bundled SDK lazily invokes a native project Skill and persists its version',
  { timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'atelier-skill-sdk-'));
    const projectPath = join(directory, 'project');
    const data = join(directory, 'data');
    const requests: MessageCreateParamsStreaming[] = [];
    const transportErrors: string[] = [];
    await mkdir(projectPath);
    const gateway = createServer(async (req, res) => {
      try {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        assert.equal(req.method, 'POST', `Unexpected mock method: ${req.method} ${path}`);
        assert.equal(path, '/v1/messages', `Unexpected mock endpoint: ${path}`);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request = JSON.parse(
          Buffer.concat(chunks).toString(),
        ) as MessageCreateParamsStreaming;
        requests.push(request);
        assert.equal(request.stream, true);
        assert.equal(request.model, model);
        assert.ok(
          JSON.stringify(request.messages).includes(prompt),
          'The fixture task reaches the SDK',
        );
        assert.ok(
          requests.length <= 2,
          'Exactly one native Skill call and one final response are expected',
        );
        streamMessage(res, requests.length === 1);
      } catch (error) {
        transportErrors.push(error instanceof Error ? error.message : String(error));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: transportErrors.at(-1) },
          }),
        );
      }
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
    const store = new Store(data);
    const runner = new AgentRunner(store, new PermissionService(store), new FileRecords(store));
    let storeClosed = false;
    try {
      const project = store.put('projects', {
        id: randomUUID(),
        name: 'SDK fixture',
        path: projectPath,
        branch: '',
        available: true,
        createdAt: now(),
      });
      const session = store.put('sessions', {
        id: randomUUID(),
        projectId: project.id,
        title: 'SDK fixture',
        status: 'active',
        sdkSessionId: null,
        draft: emptyDraft(),
        createdAt: now(),
        updatedAt: now(),
      });
      const registry = new ProjectExtensions(store);
      const installed = registry.save(project.id, {
        kind: 'skill',
        name: skillName,
        body: `---\ndescription: ${description}\n---\nInitial fixture instructions.`,
        enabled: true,
      });
      const skill = registry.save(
        project.id,
        {
          version: installed.version,
          body: `---\ndescription: ${description}\n---\n${skillBody}`,
        },
        installed.id,
      );
      assert.equal(skill.version, installed.version + 1);
      assert.ok(skill.enabled);
      // Use the same resolution/selection path as normal app submission, without
      // explicit selections or slash commands that would inline the skill body.
      const bundle = registry.resolve(project.id, 'readonly', prompt, []);
      assert.ok(!bundle.prompt.includes(bodyMarker));
      const skills = selectRunSkills(registry.list(project.id), bundle.used);
      const run: Run = store.put('runs', {
        id: randomUUID(),
        projectId: project.id,
        sessionId: session.id,
        prompt,
        mode: 'readonly',
        status: 'queued',
        createdAt: now(),
        startedAt: null,
        endedAt: null,
        reason: null,
        error: null,
        retryOf: null,
        contextPaths: [],
        attachmentIds: [],
        plan: [],
        usage: null,
        config: { gateway: gatewayUrl, model, maxTurns: 4, timeoutMs: 30_000 },
        agent: {
          id: randomUUID(),
          revisionId: randomUUID(),
          name: 'Restricted fixture',
          version: 1,
          capabilities: ['plan'],
        },
      });
      // AgentRunner gives the real bundled CLI an isolated config directory and
      // points every model request at this loopback HTTP server.
      runner.start(run, bundle.prompt, bundle.mcp, skills);
      // SDK init starts only after its first user message. Waiting for init before
      // sending that message would deadlock this real subprocess integration.
      const deadline = AbortSignal.timeout(40_000);
      while (!store.get('runs', run.id).endedAt)
        await once(store.events, 'event', { signal: deadline });
      const finished = store.get('runs', run.id);
      const events = store.runHistory(run.id).events;
      const diagnostics = JSON.stringify({
        finished,
        events,
        transportErrors,
        requestCount: requests.length,
      });
      assert.equal(finished.status, 'completed', diagnostics);
      assert.deepEqual(transportErrors, [], diagnostics);
      assert.equal(requests.length, 2, diagnostics);

      const first = requests[0]!;
      const visible = first.tools?.flatMap((item) => ('name' in item ? [item.name] : [])) ?? [];
      assert.ok(!visible.includes('Read'));
      assert.ok(!visible.includes('mcp__atelier__list_files'));
      assert.ok(!visible.includes('mcp__atelier__publish_artifact'));
      assert.ok(visible.includes('mcp__atelier__update_plan'));
      const tool = first.tools?.find((item) => 'name' in item && item.name === 'Skill');
      assert.ok(
        tool && 'input_schema' in tool,
        'The actual model request exposes the native Skill tool',
      );
      const properties = tool.input_schema.properties;
      assert.ok(
        properties && typeof properties === 'object' && 'skill' in properties,
        'Skill has its native input schema',
      );
      const initialPayload = JSON.stringify(first);
      assert.ok(
        initialPayload.includes(qualifiedSkillName),
        'Skill alias is advertised before invocation',
      );
      assert.ok(
        initialPayload.includes(description),
        'Skill description is advertised before invocation',
      );
      assert.ok(!initialPayload.includes(bodyMarker), 'Skill body is absent before invocation');

      const second = requests[1]!;
      const resultMessage = second.messages.find(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) => block.type === 'tool_result' && block.tool_use_id === toolUseId,
          ),
      );
      assert.ok(
        resultMessage && Array.isArray(resultMessage.content),
        'The real SDK returns a result for the mock model Skill tool_use',
      );
      const resultBlocks: BetaContentBlockParam[] = resultMessage.content;
      const result = resultBlocks.find(
        (block): block is BetaToolResultBlockParam =>
          block.type === 'tool_result' && block.tool_use_id === toolUseId,
      );
      assert.ok(result && !result.is_error, JSON.stringify(resultMessage));
      // Native Skill returns its launch acknowledgement as tool_result.content;
      // SKILL.md is a sibling text block in that same user result message.
      const loadedText = resultBlocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      assert.ok(
        loadedText.includes(skillBody),
        'Native Skill result message contains the full body',
      );
      assert.ok(
        loadedText.includes('Base directory for this skill:'),
        JSON.stringify(resultMessage),
      );
      const initialized = events.find((event) => event.type === 'sdk.initialized');
      assert.ok(initialized, diagnostics);
      assert.ok((initialized.payload.tools as string[]).includes('Skill'), diagnostics);
      const discovered = events.find((event) => event.type === 'skills.discovered');
      const reference = { id: skill.id, name: skillName, version: skill.version };
      assert.deepEqual(discovered?.payload.items, [reference], diagnostics);
      assert.deepEqual(discovered?.payload.missing, [], diagnostics);
      const invoked = events.filter((event) => event.type === 'skill.invoked');
      assert.equal(invoked.length, 1, diagnostics);
      assert.deepEqual(invoked[0]!.payload, {
        extensionId: skill.id,
        name: skillName,
        version: skill.version,
      });
      const tools = store.list('tools').filter((item) => item.runId === run.id);
      assert.equal(tools.length, 1, diagnostics);
      assert.equal(tools[0]!.name, 'Skill');
      assert.equal(tools[0]!.status, 'succeeded');
      assert.deepEqual(JSON.parse(tools[0]!.inputSummary), { skill: qualifiedSkillName });
      assert.ok(
        store
          .list('messages')
          .some(
            (message) =>
              message.runId === run.id &&
              message.role === 'assistant' &&
              message.text.includes(answer),
          ),
        diagnostics,
      );
      assert.equal(
        events.find((event) => event.type === 'process.exited')?.payload.code,
        0,
        diagnostics,
      );
      assert.ok(!events.some((event) => event.type === 'sdk.api_retry'), diagnostics);
      assert.ok(
        !(await readdir(join(data, 'sdk', session.id))).some((name) => name.startsWith('skills-')),
        'Run plugin directory is cleaned after the SDK exits',
      );

      await runner.shutdown();
      store.close();
      storeClosed = true;
      const reopened = new Store(data);
      try {
        const persisted = reopened
          .runHistory(run.id)
          .events.filter((event) => event.type === 'skill.invoked');
        assert.deepEqual(
          persisted,
          invoked,
          'Invocation name/version survive closing and reopening SQLite',
        );
      } finally {
        reopened.close();
      }
      t.diagnostic(
        `Bundled CLI ${initialized.payload.version}: two loopback streaming Messages requests; Skill ${qualifiedSkillName} v${skill.version}; body loaded after invocation; skill.invoked persisted in SQLite.`,
      );
    } finally {
      await runner.shutdown();
      if (!storeClosed) store.close();
      gateway.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        gateway.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
