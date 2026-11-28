/**
 * @file Runs paired local-model evaluations of task planning and delivery.
 * @implementation Runs paired Ollama trials with shared fixtures and seeds, feeds each candidate plan to a fixed executor, and verifies the generated HTML with isolated Chromium.
 * @updated 2026-11-28T19:12:00+08:00
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { chromium, type Browser } from 'playwright-core';
import { z } from 'zod';
import {
  buildTaskPlanGuidance,
  taskPlanToolDescription,
} from '../server/modules/runs/task-plan-guidance.js';
import { snapshot, writeFixture } from './harness-eval.mjs';
import {
  deliverySchema,
  failedHtml,
  gradeDelivery,
  gradePlan,
  containsHtmlFacts,
  makeTrial,
  planSchema,
  taskIds,
  type Checks,
} from './task-plan-eval-cases.mjs';

const exec = promisify(execFile);
const gateway = 'http://127.0.0.1:11434';
const baseline = [
  '复杂任务用 update_plan 记录真实计划，简单问题无需计划。',
  'Record or update the real task plan. Use only for tasks that benefit from steps; status changes must reflect actual work. This does not grant permissions.',
].join('\n');
const current = [buildTaskPlanGuidance({ mode: 'auto' }), taskPlanToolDescription].join('\n');
const sampling = { temperature: 0.2, num_ctx: 4096 };
const tokenLimits = { planning: 600, htmlDelivery: 3200, otherDelivery: 1800 };
const planner =
  '你是工作台的规划助手，只处理下面的请求和提供的文件。把计划条目写入 steps。复杂任务选 plan；需要先澄清就选 clarify 并在 reply 写明需要什么；能直接答复就选 direct，在 reply 写实际答案。clarify 或 direct 时 steps 为空。这里只生成规划，不执行工作。';
const executor =
  '你是工作台的执行助手，按用户请求实际完成任务。用户请求优先于候选清单。下面提供了所有可用的文件内容。用户需要文件时，将确实生成的每个文件以 {"path":"文件名","content":"完整文件内容"} 写入 files。reply 只放回复给用户的文字，文件内容放在 files。仅需在回复里交付或缺关键材料时 files 为空。此调用无法打开浏览器或打印，评测器之后会实测 HTML。基于可用事实完成工作，不宣称已经实测。';

async function ollama(path: string, payload?: object, timeout = 5000): Promise<unknown> {
  const response = await fetch(gateway + path, {
    ...(payload === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Ollama ${path}: HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

const responseSchema = z.object({
  model: z.string(),
  done_reason: z.string(),
  message: z.object({ content: z.string() }),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

async function infer<T extends z.ZodType>(
  model: string,
  seed: number,
  schema: T,
  system: string,
  user: string,
  numPredict: number,
) {
  const start = performance.now();
  const raw = responseSchema.parse(
    await ollama(
      '/api/chat',
      {
        model,
        think: false,
        stream: false,
        format: z.toJSONSchema(schema),
        options: { ...sampling, seed, num_predict: numPredict },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      75_000,
    ),
  );
  const receipt = { raw, elapsedMs: Math.round(performance.now() - start) };
  try {
    if (raw.model !== model) throw new Error(`Unexpected served model: ${raw.model}`);
    if (raw.done_reason !== 'stop') throw new Error(`Incomplete response: ${raw.done_reason}`);
    return {
      ...receipt,
      value: schema.parse(JSON.parse(raw.message.content) as unknown),
      error: null,
    };
  } catch (error) {
    return { ...receipt, value: null, error: String(error) };
  }
}

export async function verifyHtml(
  browser: Browser,
  content: string | undefined,
  folder: string,
): Promise<Checks> {
  if (!content) return failedHtml;
  const context = await browser.newContext({
    javaScriptEnabled: false,
    offline: true,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  const documentUrl = 'http://task-plan-eval.invalid/handout.html';
  let resourceRequests = 0;
  await context.route('**/*', (route) => {
    if (route.request().url() !== documentUrl || route.request().resourceType() !== 'document') {
      resourceRequests += 1;
      return route.abort();
    }
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      headers: {
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
      },
      body: content,
    });
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.setViewportSize({ width: 375, height: 850 });
    await page.goto(documentUrl, { waitUntil: 'load' });
    const inspect = () =>
      page.evaluate(() => ({
        text: document.body.innerText,
        fits: document.documentElement.scrollWidth <= innerWidth,
        external: [...document.querySelectorAll('[src], link[href], [srcset], [poster]')].some(
          (element) =>
            ['src', 'href', 'srcset', 'poster'].some((name) =>
              /(?:https?:)?\/\//iu.test(element.getAttribute(name) ?? ''),
            ),
        ),
      }));
    const mobile = await inspect();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const desktop = await inspect();
    const pdf = join(folder, 'verification.pdf');
    await page.pdf({ path: pdf, preferCSSPageSize: true });
    const [info, print] = await Promise.all([
      exec('pdfinfo', [pdf], { timeout: 5000 }),
      exec('pdftotext', [pdf, '-'], { timeout: 5000 }),
    ]);
    const size = /Page size:\s+([\d.]+) x ([\d.]+) pts/u.exec(info.stdout);
    return {
      containsFacts: containsHtmlFacts(mobile.text) && containsHtmlFacts(desktop.text),
      offline:
        resourceRequests === 0 &&
        !mobile.external &&
        !desktop.external &&
        !/url\(\s*['"]?(?:https?:)?\/\//iu.test(content),
      mobile: mobile.fits,
      desktop: desktop.fits,
      singleA4:
        /^Pages:\s+1$/mu.test(info.stdout) &&
        Math.abs(Number(size?.[1]) - 595.28) < 2 &&
        Math.abs(Number(size?.[2]) - 841.89) < 2,
      printFacts: containsHtmlFacts(print.stdout),
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: 'boolean' },
      list: { type: 'boolean' },
      help: { type: 'boolean' },
      model: { type: 'string', default: 'qwen3.5:9b' },
      seed: { type: 'string', default: '126' },
      repeats: { type: 'string', default: '1' },
      tasks: { type: 'string' },
      out: { type: 'string' },
      chromium: { type: 'string', default: '/usr/bin/chromium' },
    },
  });
  if (values.help || (!values.run && !values.list)) {
    console.log(
      'Usage: node --import tsx scripts/task-plan-eval.mts --run [--model ID] [--tasks LIST] [--seed N] [--repeats N] [--out NEW_DIR] [--chromium PATH]\nUse --list to see the tasks. Inference is opt-in and only uses installed models on local Ollama.',
    );
    return;
  }
  if (values.list) {
    console.log(taskIds.join('\n'));
    return;
  }
  const model = values.model;
  const seed = z.coerce
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 10)
    .parse(values.seed);
  const repeats = z.coerce.number().int().min(1).max(5).parse(values.repeats);
  const tasks = z
    .array(z.enum(taskIds))
    .nonempty()
    .parse(values.tasks?.split(',') ?? taskIds);
  if (new Set(tasks).size !== tasks.length) throw new Error('Duplicate tasks');
  const models = z
    .object({
      models: z.array(z.object({ name: z.string(), size: z.number(), digest: z.string() })),
    })
    .parse(await ollama('/api/tags'));
  const installed = models.models.find((entry) => entry.name === model && entry.size > 1_000_000);
  if (!installed || /cloud/iu.test(model)) throw new Error(`No installed local model: ${model}`);
  const metadata = z
    .object({ remote_host: z.string().optional(), remote_model: z.string().optional() })
    .parse(await ollama('/api/show', { model }));
  if (metadata.remote_host || metadata.remote_model)
    throw new Error('Remote models are outside this evaluation');
  if (tasks.includes('html'))
    await Promise.all([exec('pdfinfo', ['-v']), exec('pdftotext', ['-v'])]);
  const out = values.out
    ? resolve(values.out)
    : await mkdtemp(join(tmpdir(), 'atelier-task-plan-eval-'));
  if (values.out) await mkdir(out);
  const version = await ollama('/api/version');
  const browser = tasks.includes('html')
    ? await chromium.launch({ executablePath: values.chromium, chromiumSandbox: true })
    : undefined;
  const report = {
    version: 2,
    model: installed,
    ollama: version,
    browser: browser?.version(),
    sampling,
    tokenLimits,
    seed,
    repeats,
    tasks,
    planner,
    executor,
    planningGuidance: { baseline, current },
  };
  const results = [];
  console.log(`Evidence: ${out}`);
  try {
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const [index, task] of tasks.entries()) {
        const fixture = makeTrial(task);
        const input = { request: fixture.request, availableFiles: fixture.files };
        const order =
          (index + repeat) % 2
            ? (['current', 'baseline'] as const)
            : (['baseline', 'current'] as const);
        for (const variant of order) {
          const folder = join(out, `${repeat + 1}-${task}-${variant}`);
          const project = join(folder, 'project');
          await writeFixture(project, fixture);
          const planning = await infer(
            model,
            seed + repeat,
            planSchema,
            `${planner}\n${report.planningGuidance[variant]}`,
            JSON.stringify(input),
            tokenLimits.planning,
          ).catch((error: unknown) => ({ value: null, error: String(error) }));
          const execution = await infer(
            model,
            seed + repeat,
            deliverySchema,
            executor,
            JSON.stringify({ task: input, candidate: planning.value }),
            task === 'html' ? tokenLimits.htmlDelivery : tokenLimits.otherDelivery,
          ).catch((error: unknown) => ({ value: null, error: String(error) }));
          const accepted = execution.value?.files.find(({ path }) => path === fixture.output);
          if (accepted)
            await writeFile(join(project, accepted.path), accepted.content, { flag: 'wx' });
          const files = await snapshot(project);
          const delivered = Object.fromEntries(
            Object.entries(files).filter(([path]) => !Object.hasOwn(fixture.files, path)),
          );
          const browserErrors: string[] = [];
          const rendered =
            task === 'html' && browser
              ? await verifyHtml(browser, delivered['handout.html'], folder).catch(
                  (error: unknown) => {
                    browserErrors.push(String(error));
                    return failedHtml;
                  },
                )
              : {};
          const planChecks = planning.value
            ? gradePlan(task, planning.value)
            : { validResponse: false };
          const deliveryChecks = execution.value
            ? {
                ...gradeDelivery(task, execution.value, delivered, rendered),
                preservedSources: Object.entries(fixture.files).every(
                  ([path, content]) => files[path] === content,
                ),
              }
            : { validResponse: false };
          const planPass = Object.values(planChecks).every(Boolean);
          const deliveryPass = Object.values(deliveryChecks).every(Boolean);
          results.push({
            task,
            variant,
            seed: seed + repeat,
            fixture,
            planning,
            execution,
            planChecks,
            deliveryChecks,
            planPass,
            deliveryPass,
            browserErrors,
            folder,
          });
          await writeFile(
            join(out, 'report.json'),
            JSON.stringify({ ...report, results }, null, 2) + '\n',
          );
          console.log(`${repeat + 1} ${task} ${variant} plan=${planPass} delivery=${deliveryPass}`);
        }
      }
    }
  } finally {
    await browser?.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
