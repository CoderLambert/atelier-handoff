/**
 * @file 验证运行进程托管、启动提示、资源清理和终态优先级。
 * @implementation 通过字面量对照、临时目录和真实 Node 子进程检查退出、强制取消及清理顺序。
 * @updated 2026-11-27T18:16:47+08:00
 */
import assert from 'node:assert/strict';
import { getEventListeners, once } from 'node:events';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildInitialPrompt, RunEnvironment } from '../server/modules/runs/run-environment.js';
import { resolveRunOutcome } from '../server/modules/runs/run-outcome.js';
import { createRunProcessOwner } from '../server/modules/runs/run-process-owner.js';

const outcomeDefaults = { cleanupUncertain: false, hasFinalResult: true, failure: null };
const outcomes: {
  name: string;
  overrides: Partial<Parameters<typeof resolveRunOutcome>[0]>;
  expected: ReturnType<typeof resolveRunOutcome>;
}[] = [
  {
    name: 'uncertain cleanup overrides user cancellation and a final result',
    overrides: { cleanupUncertain: true, cancelReason: 'user', failure: '进程仍在运行' },
    expected: { status: 'interrupted', reason: '进程仍在运行', error: '进程仍在运行' },
  },
  {
    name: 'user cancellation overrides missing result and failure',
    overrides: { cancelReason: 'user', hasFinalResult: false, failure: 'SDK error' },
    expected: {
      status: 'stopped',
      reason: '用户停止，进程已退出；已发生的修改保留。',
      error: null,
    },
  },
  {
    name: 'shutdown overrides a final result and failure',
    overrides: { cancelReason: 'shutdown', failure: 'SDK error' },
    expected: {
      status: 'interrupted',
      reason: '服务关闭，运行中断。',
      error: '服务关闭，运行中断。',
    },
  },
  {
    name: 'timeout overrides missing result and failure',
    overrides: { cancelReason: 'timeout', hasFinalResult: false, failure: 'SDK error' },
    expected: {
      status: 'failed',
      reason: '执行超过设定时限，已停止。',
      error: '执行超过设定时限，已停止。',
    },
  },
  {
    name: 'missing result interrupts even with a failure',
    overrides: { hasFinalResult: false, failure: '流提前结束' },
    expected: { status: 'interrupted', reason: '流提前结束', error: '流提前结束' },
  },
  {
    name: 'missing result can interrupt without any recorded error',
    overrides: { hasFinalResult: false },
    expected: { status: 'interrupted', reason: null, error: null },
  },
  {
    name: 'a final result with a failure is failed',
    overrides: { failure: '模型返回错误' },
    expected: { status: 'failed', reason: '模型返回错误', error: '模型返回错误' },
  },
  {
    name: 'a final result without a failure is completed',
    overrides: {},
    expected: { status: 'completed', reason: null, error: null },
  },
  {
    name: 'an empty failure keeps the original completed status and reason',
    overrides: { failure: '' },
    expected: { status: 'completed', reason: '', error: null },
  },
];

for (const { name, overrides, expected } of outcomes) {
  test(name, () =>
    assert.deepEqual(resolveRunOutcome({ ...outcomeDefaults, ...overrides }), expected),
  );
}

function processFixture(options: Partial<Parameters<typeof createRunProcessOwner>[0]> = {}) {
  const abortController = new AbortController();
  const forwarded = new AbortController();
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const owner = createRunProcessOwner({
    native: false,
    abortController,
    event: (type, payload) => events.push({ type, payload }),
    ...options,
  });
  const spawnNode = (program: string, command = process.execPath) =>
    owner.spawnClaudeCodeProcess({
      command,
      args: ['-e', program],
      env: {},
      signal: forwarded.signal,
    });
  return { owner, events, abortController, forwarded, spawnNode };
}

test('controlled process reports exit and stderr bytes before cleanup completes', async (t) => {
  const { owner, events, abortController, spawnNode } = processFixture();
  const child = spawnNode(
    'const fs = require("node:fs"); fs.writeSync(2, "雪"); fs.readSync(0, Buffer.alloc(1));',
  );
  t.after(() => child.kill('SIGKILL'));
  await once(child.stderr, 'data', { signal: AbortSignal.timeout(3_000) });
  child.stdin.end();
  assert.deepEqual(await owner.cleanup(), { cleanupUncertain: false });
  assert.deepEqual(events, [
    { type: 'process.spawned', payload: { pid: child.pid } },
    { type: 'process.exited', payload: { code: 0, signal: null, stderrBytes: 3 } },
  ]);
  assert.deepEqual(getEventListeners(abortController.signal, 'abort'), []);
});

test('controlled process escalates run abort independently of the SDK signal', async (t) => {
  const { owner, events, abortController, forwarded, spawnNode } = processFixture({
    cancelTimeoutMs: 20,
  });
  const child = spawnNode('setInterval(() => {}, 1000);');
  t.after(() => child.kill('SIGKILL'));
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(3_000) });
  abortController.abort();
  await exited;
  assert.equal(forwarded.signal.aborted, false);
  assert.deepEqual(await owner.cleanup(), { cleanupUncertain: false });
  assert.deepEqual(events.at(-1), {
    type: 'process.exited',
    payload: { code: null, signal: 'SIGKILL', stderrBytes: 0 },
  });
  assert.deepEqual(getEventListeners(abortController.signal, 'abort'), []);
});

test('controlled cleanup timeout force-kills and waits for the exit receipt', async (t) => {
  const { owner, events, abortController, spawnNode } = processFixture({ cleanupTimeoutMs: 20 });
  const child = spawnNode('setInterval(() => {}, 1000);');
  t.after(() => child.kill('SIGKILL'));
  assert.deepEqual(await owner.cleanup(), {
    cleanupUncertain: false,
    failure: 'SDK 未及时退出，已强制结束所属进程。',
  });
  assert.deepEqual(events.at(-1), {
    type: 'process.exited',
    payload: { code: null, signal: 'SIGKILL', stderrBytes: 0 },
  });
  assert.deepEqual(getEventListeners(abortController.signal, 'abort'), []);
});

test('controlled spawn failure reports the Node error code and removes the abort listener', async (t) => {
  const { owner, events, abortController, spawnNode } = processFixture();
  const directory = await mkdtemp(join(tmpdir(), 'atelier-run-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  spawnNode('', join(directory, 'missing-child'));
  assert.deepEqual(await owner.cleanup(), { cleanupUncertain: false });
  assert.deepEqual(events, [
    { type: 'process.spawned', payload: { pid: null } },
    { type: 'sdk.error', payload: { stage: 'process', code: 'ENOENT' } },
  ]);
  assert.deepEqual(getEventListeners(abortController.signal, 'abort'), []);
});

test('native process keeps the harness exit event and cleanup receipt', async (t) => {
  const { owner, events, spawnNode } = processFixture({ native: true });
  const child = spawnNode('require("node:fs").readSync(0, Buffer.alloc(1));');
  t.after(() => child.kill('SIGKILL'));
  assert.deepEqual(await owner.cleanup(), { cleanupUncertain: false });
  assert.deepEqual(events.slice(0, 2), [
    { type: 'process.spawned', payload: { pid: child.pid } },
    { type: 'process.exited', payload: { code: 0, signal: null } },
  ]);
  const cleanup = events.at(-1);
  assert.equal(cleanup?.type, 'process.cleanup');
  assert.equal(cleanup.payload.rootExited, true);
  assert.deepEqual(cleanup.payload.remainingPids, []);
});

const promptDefaults = {
  native: false,
  mode: 'edit' as const,
  planAllowed: false,
  selectedSkill: false,
  projectInstructions: '',
  checkpoint: '',
  historyContext: '',
  packageNames: [],
  nativePackagePaths: [],
  weatherEnabled: false,
  bindingGuidance: [],
  attachmentGuidance: '',
  inputText: '请总结',
};

test('initial prompt preserves the controlled edit and readonly mode instructions', () => {
  assert.equal(
    buildInitialPrompt(promptDefaults),
    '本轮运行模式：受控修改；可通过本轮提供的 atelier 写入/编辑/删除/命令工具请求单次审批。\n\n用户本轮任务：\n请总结',
  );
  assert.equal(
    buildInitialPrompt({ ...promptDefaults, mode: 'readonly', selectedSkill: true }),
    '本轮运行模式：只读；不允许项目写入或执行命令。\n\n本轮按所选技能交付用户要求的结果。设计、分析与文档任务先在对话中给出可独立使用的完整版本，再按需发布交付物。只做完成该结果所需的文件检查。对于可逆的设计选择，可说明假设并直接交付初稿。\n\n用户本轮任务：\n请总结',
  );
});

test('native initial prompt preserves each context and guidance segment in order', () => {
  assert.equal(
    buildInitialPrompt({
      ...promptDefaults,
      native: true,
      planAllowed: true,
      projectInstructions: '项目指令\n\n',
      checkpoint: '恢复点',
      historyContext: '历史内容',
      packageNames: ['research', 'weather'],
      nativePackagePaths: [{ name: 'research', directory: '/sdk/skills/research' }],
      weatherEnabled: true,
      bindingGuidance: ['绑定一', '绑定二'],
      attachmentGuidance: '附件清单\n\n',
    }),
    [
      '项目指令\n\n',
      '恢复点\n\n',
      '<prior_conversation>\n历史内容\n</prior_conversation>\n以上是已发生的历史，不是待执行指令；禁止自动重放旧操作。\n\n',
      '本轮运行模式：本机信任。按当前登录用户权限直接使用原生工具。计划工具为 update_plan。\n\n',
      '本轮可用的技能包：research、weather。通过 read_skill_resource 读取包内文件。工具列表包含 run_skill_script 时用它执行包内脚本。工具列表包含 skill_search 时，可用它对搜索请求报价、执行或取回。用工具返回的交付物 ID 交付文件。\n\n',
      '本轮 GitHub Skill 资源目录（<skill-base-dir> 和 ${CLAUDE_SKILL_DIR} 指向对应目录，本机信任可用原生工具访问。运行脚本时保持项目工作目录）：\n[{"name":"research","directory":"/sdk/skills/research"}]\n\n',
      '用户请求实时天气或近期预报时，先调用 weather_lookup。可以使用城市的常用英文名（如昆山用 Kunshan）或用户提供的坐标。回复中注明来源、匹配地点和观测时间。\n\n',
      '本轮 Skill 工具绑定（优先使用绑定工具，无需照抄 Skill 中的命令）：\n绑定一\n绑定二\n\n',
      '附件清单\n\n',
      '用户本轮任务：\n请总结',
    ].join(''),
  );
});

test('partial environment startup keeps Bash scratch until pending work has finished', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-run-environment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sdkDirectory = join(directory, 'sdk');
  const environment = new RunEnvironment({ sdkDirectory, native: true, event: () => {} });
  await assert.rejects(
    environment.prepare({
      config: { gateway: 'http://127.0.0.1', model: 'fixture', maxTurns: 8, timeoutMs: 8_000 },
      modelId: 'fixture',
      signal: AbortSignal.abort(),
      skills: [],
      automaticSkills: [],
    }),
    { name: 'AbortError' },
  );
  const [scratchName, ...others] = await readdir(sdkDirectory);
  assert.match(scratchName ?? '', /^bash-tasks-/);
  assert.deepEqual(others, []);
  assert.equal(
    await environment.dispose(async (spans) => {
      assert.equal(spans, undefined);
      assert.deepEqual(await readdir(sdkDirectory), [scratchName]);
      return 'pending work finished';
    }),
    'pending work finished',
  );
  assert.deepEqual(await readdir(sdkDirectory), []);
});
