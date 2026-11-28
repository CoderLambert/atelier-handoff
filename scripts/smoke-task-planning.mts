/**
 * @file 在隔离 Linux Electron 验证双语任务规划设置和聊天历史。
 * @implementation 真实 SDK 连接回环模型，检查工具可用性、同会话设置更新、关闭状态和交付修正。
 * @updated 2026-11-28T21:12:24+08:00
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type Page } from 'playwright-core';
import { z } from 'zod';
import { acceptanceReceipt } from '../shared/run-acceptance.js';
import { defaultTaskPlanningPrompt } from '../shared/task-planning.js';
import { sendModelReply } from '../tests/fixtures/subagent-gateway.js';

const scratch = await mkdtemp(join(tmpdir(), 'atelier-task-planning-smoke-'));
const project = join(scratch, 'project');
await mkdir(project);
const model = 'planning-loopback-fixture';
const planningTool = 'mcp__atelier__update_plan';
const requests: { names: string[]; request: string }[] = [];
const gateway = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
    res.end('{}');
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  const { tools } = z
    .object({ tools: z.array(z.object({ name: z.string() })) })
    .parse(JSON.parse(raw));
  requests.push({ names: tools.map(({ name }) => name), request: raw });
  const index = requests.length;
  const zh = index === 1;
  sendModelReply(
    res,
    model,
    index === 1 || index === 5
      ? [
          {
            name: planningTool,
            id: 'toolu_plan_' + index,
            input: {
              steps: [
                { content: zh ? '核对历史清单' : 'Check the model override', status: 'completed' },
              ],
            },
          },
        ]
      : index === 2
        ? '中文清单已记录。'
        : index === 3
          ? '21'
          : index === 4
            ? '22'
            : 'The English checklist is recorded.',
  );
});
gateway.listen(0, '127.0.0.1');
await once(gateway, 'listening');
const address = gateway.address();
assert.ok(address && typeof address !== 'string');

async function select(page: Page, field: string, option: string) {
  await page.getByRole('combobox', { name: field, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function failNextSave(page: Page) {
  const endpoint = '**/api/settings/task-planning';
  await page.route(endpoint, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    await route.fulfill({ status: 503, json: { code: 'SHUTTING_DOWN' } });
    await page.unroute(endpoint);
  });
}

async function send(page: Page, prompt: string) {
  const input = page.locator('#prompt-input');
  await input.fill(prompt);
  await input.press('Enter');
}

const snapshotSchema = z.object({
  runs: z.array(z.object({ id: z.string(), status: z.string(), plan: z.array(z.unknown()) })),
  events: z.array(z.object({ runId: z.string(), type: z.string(), payload: z.unknown() })),
});
async function snapshot(page: Page) {
  const id = new URL(page.url()).hash.split('/').at(-1);
  return snapshotSchema.parse(
    await page.evaluate(
      async (sessionId) => (await fetch('/api/sessions/' + sessionId)).json(),
      id,
    ),
  );
}

try {
  const app = await _electron.launch({
    chromiumSandbox: true,
    executablePath: resolve('node_modules/electron/dist/electron'),
    args: [
      resolve('dist/desktop/main.mjs'),
      '--user-data-dir=' + join(scratch, 'profile'),
      '--disable-gpu',
      ...(process.env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : []),
    ],
    env: {
      ...process.env,
      ATELIER_PORT: '0',
      ATELIER_DATA_DIR: join(scratch, 'data'),
      ATELIER_GATEWAY: 'http://127.0.0.1:' + address.port,
      ATELIER_GATEWAY_TOKEN: model,
      ATELIER_MODEL: model,
      ATELIER_MAGPIE_URL: '',
    },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(25_000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    const bind = page.getByRole('dialog', { name: '绑定项目目录' });
    await bind.getByLabel('本机目录').fill(project);
    await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
    await bind.waitFor({ state: 'hidden' });

    await send(page, '请跟踪进度并列出一项任务。');
    await page.getByText('中文清单已记录。', { exact: true }).waitFor();
    await page.waitForURL('**/#/sessions/*');
    const conversation = page.url();
    await page.locator('.chat-task-plan').first().waitFor();
    const settings = new URL('/#/settings/models', conversation).href;
    await page.goto(settings);
    await page.getByRole('button', { name: '任务规划', exact: true }).click();
    await page.getByRole('heading', { name: '任务规划', exact: true }).waitFor();
    const zhMode = page.getByRole('combobox', { name: '默认清单模式', exact: true });
    assert.equal((await zhMode.textContent())?.trim(), '自动（默认）');
    await failNextSave(page);
    await select(page, '默认清单模式', '关闭');
    await page.getByRole('alert').getByText('无法保存设置，请重试。').waitFor();
    assert.equal((await zhMode.textContent())?.trim(), '自动（默认）');
    await select(page, '默认清单模式', '关闭');
    await page.getByText('已保存。', { exact: true }).waitFor();

    await page.goto(conversation);
    await send(page, '只回复 22。');
    await page.getByText('22', { exact: true }).waitFor();
    const off = await snapshot(page);
    const second = off.runs.at(-1);
    assert.equal(second?.status, 'completed');
    assert.deepEqual(second.plan, []);
    assert.ok(
      !off.events.some((event) => event.runId === second.id && event.type === 'plan.updated'),
    );
    assert.equal(await page.locator('.chat-task-plan').count(), 1);
    assert.equal(requests.length, 4);
    assert.ok(requests[0]?.names.includes(planningTool));
    for (const request of requests.slice(2))
      assert.ok(
        !request.names.some((name) =>
          [planningTool, 'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'].includes(
            name,
          ),
        ),
      );
    const corrections = off.events
      .filter((event) => event.runId === second.id && event.type === 'run.acceptance_checked')
      .map(({ payload }) => acceptanceReceipt.parse(payload));
    assert.deepEqual(
      corrections.map(({ correctionRequested }) => correctionRequested),
      [true, false],
    );

    await page.goto(settings);
    await select(page, '界面语言', 'English');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
    await page.getByRole('button', { name: 'Task planning', exact: true }).click();
    await page.getByText('Advanced settings', { exact: true }).click();
    await page.getByLabel('Model ID', { exact: true }).fill(model);
    await select(page, 'Checklist mode for this model', 'Only when I ask');
    await page.getByText('Saved.', { exact: true }).waitFor();
    const editor = page.getByLabel('Task breakdown prompt', { exact: true });
    assert.equal(await editor.inputValue(), defaultTaskPlanningPrompt);
    const customPrompt = 'Use the headings from the checked request.';
    await editor.fill(customPrompt);
    assert.equal(await page.getByText('Saved.', { exact: true }).count(), 0);
    await failNextSave(page);
    await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
    await page.getByRole('alert').getByText('Could not save settings. Try again.').waitFor();
    assert.equal(await editor.inputValue(), customPrompt);
    await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
    await page.getByText('Saved.', { exact: true }).waitFor();

    await page.goto(conversation);
    await send(page, 'Please list one task and track its progress.');
    await page.getByText('The English checklist is recorded.', { exact: true }).waitFor();
    assert.equal(requests.length, 6);
    assert.ok(requests[4]?.names.includes('TodoWrite'));
    assert.ok(requests[4]?.request.includes(customPrompt));
    await page.reload();
    await page.getByText('The English checklist is recorded.', { exact: true }).waitFor();
    const restored = await snapshot(page);
    assert.deepEqual(
      restored.runs.map(({ plan }) => plan.length),
      [1, 0, 1],
    );
    const historical = page.locator('.chat-task-plan').filter({ hasText: '核对历史清单' });
    await historical.waitFor();
    const english = page.getByRole('button', { name: 'Task plan · 1 / 1 complete' });
    if ((await english.count()) && (await english.getAttribute('aria-expanded')) === 'false')
      await english.click();
    await page.getByText('Check the model override', { exact: true }).waitFor();

    await page.goto(settings);
    await page.getByRole('button', { name: 'Task planning', exact: true }).click();
    await page.getByText('Advanced settings', { exact: true }).click();
    await page.getByRole('button', { name: 'Restore default prompt', exact: true }).click();
    await page.getByText('Saved.', { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel('Task breakdown prompt', { exact: true }).inputValue(),
      defaultTaskPlanningPrompt,
    );
    console.log(
      'Passed Linux Electron zh-CN 1440×900 and en 1280×800: settings, both tools gated while off, no empty card, one delivery correction, model override, custom prompt, history after reload, restore defaults.',
    );
  } finally {
    await app.close();
  }
} finally {
  gateway.closeAllConnections();
  await new Promise<void>((done) => gateway.close(() => done()));
  await rm(scratch, { recursive: true, force: true });
}
