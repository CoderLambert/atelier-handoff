/**
 * @file Defines paired task-plan fixtures and deterministic quality checks.
 * @implementation Scores required plan steps, delivered text and permitted files, and includes browser observations supplied by the evaluator.
 * @updated 2026-11-28T19:11:00+08:00
 */
import { z } from 'zod';

export const planSchema = z.strictObject({
  kind: z.enum(['plan', 'clarify', 'direct']),
  steps: z.array(z.string().min(1).max(500)).max(12),
  reply: z.string().max(2000),
});
export const deliverySchema = z.strictObject({
  files: z
    .array(z.strictObject({ path: z.string().max(120), content: z.string().max(20000) }))
    .max(4),
  reply: z.string().max(20000),
});
export type Plan = z.infer<typeof planSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type Checks = Record<string, boolean>;

export const taskIds = [
  'html',
  'calculation',
  'readonly',
  'missing',
  'revision',
  'simple',
] as const;
export type TaskId = (typeof taskIds)[number];

const codes = ['ARC-604', 'ARC-718', 'ARC-832'];
const htmlFacts = ['Cedar Repair Day', '09:30 UTC', ...codes];
export function containsHtmlFacts(text: string): boolean {
  const visibleText = text.replace(/\s+/gu, ' ');
  return htmlFacts.every((fact) => visibleText.includes(fact));
}

const trials = {
  html: {
    request:
      '把 source/event.md 做成可离线打开的单文件 handout.html。保留活动标题、开放时间和三个工位编号。要求实际检查 375px、1440px 布局和单页 A4 打印，再交付 HTML 原件。只交付该 HTML 文件。',
    files: {
      'source/event.md': `# Cedar Repair Day\n开放时间：09:30 UTC\n工位编号：${codes.join('、')}\n`,
    },
    output: 'handout.html',
  },
  calculation: {
    request:
      '用当前口径计算在售商品的平均价，回复包含分子、分母、平均价和实际使用的两个来源路径。保留原文件。',
    files: {
      'rules/pricing.md':
        '当前口径：仅 status=active 的商品，每条记录算一件，按 price 计算算术平均。',
      'rules/archive.md': '废弃口径：使用所有商品，按 list_price 计算。',
      'data/products.csv':
        'sku,status,price,list_price\nA,active,16,50\nB,archived,31,70\nC,active,18,53\nD,active,20,68\n',
    },
    output: null,
  },
  readonly: {
    request:
      '只读查看 reports/refresh.log 和 src/refresh.ts。解释这次刷新为何失败，必须引用两个相对路径和日志里的具体证据编号。原文件保持原样。',
    files: {
      'reports/refresh.log':
        '18:24:01 SKIP recording reason=VALIDATION_FAIL code=RFX-731 field=batchSize actual=0 min=1\n',
      'src/refresh.ts':
        "export function refresh(batchSize: number) { if (batchSize < 1) throw new Error('invalid batchSize'); return batchSize; }\n",
    },
    output: null,
  },
  missing: {
    request:
      '按会议逐字稿 transcript.txt 提取确定的决议和责任人，交付 minutes.md。如果逐字稿缺失，先告诉我需要补什么。',
    files: { 'agenda.md': '# 议程\n讨论灰度节奏与负责人，现场决定。\n' },
    output: null,
  },
  revision: {
    request:
      '前一轮原计划是读取 release/notes.md、写 handoff.md、再制作 handoff.pdf。我改了要求，取消 PDF。只保存可编辑的 handoff.md，核对 /status 和 /export 两条路径。只依据记录，未确认的路径明确标记待核实。',
    files: {
      'release/notes.md': '# 发布记录\n/status 已走验收，编号 GREEN-712。\n/export 尚未核对。\n',
    },
    output: 'handoff.md',
  },
  simple: {
    request: '只回复计算结果。8 加 14 等于多少？',
    files: {},
    output: null,
  },
} satisfies Record<
  TaskId,
  { request: string; files: Record<string, string>; output: string | null }
>;

export function makeTrial(task: TaskId) {
  return { task, ...trials[task] };
}

const asksForTranscript = (text: string) =>
  /(?:请|提供|上传|补充|需要|缺少)/u.test(text) && /逐字稿|transcript\.txt/iu.test(text);
const a4 = /A4/iu;
const reading = /读取|查看|核对|读/u;
export const failedHtml = {
  containsFacts: false,
  offline: false,
  mobile: false,
  desktop: false,
  singleA4: false,
  printFacts: false,
};

function reportsNumber(answer: string, label: RegExp, expected: number) {
  return answer.split(/[\n，。；;]/u).some((clause) => {
    const start = clause.search(label);
    if (start < 0) return false;
    const numbers = clause.slice(start).match(/-?\d+(?:\.\d+)?/gu);
    return Number(numbers?.at(-1)) === expected;
  });
}

function markdownPathEvidence(content: string, path: string) {
  const heading = /^\s*#{1,6}\s/u;
  const lines = content.split('\n');
  const evidence = lines.flatMap((line, index) => {
    if (!line.includes(path)) return [];
    const cells = line.split('|').map((cell) => cell.trim());
    const pathCell = cells.findIndex((cell) => cell.replace(/^`|`$/gu, '') === path);
    const stateCell = pathCell >= 0 ? cells[pathCell + 1] : undefined;
    if (stateCell) return [{ state: stateCell, text: line }];
    if (!heading.test(line)) return [{ state: line, text: line }];
    const end = lines.findIndex((next, position) => position > index && heading.test(next));
    const section = lines.slice(index, end < 0 ? undefined : end).join('\n');
    return [{ state: section, text: section }];
  });
  return {
    state: evidence.map(({ state }) => state).join('\n'),
    text: evidence.map(({ text }) => text).join('\n'),
  };
}

export function gradePlan(task: TaskId, plan: Plan): Checks {
  if (task === 'simple')
    return {
      direct: plan.kind === 'direct' && plan.steps.length === 0,
      answer: plan.reply.trim() === '22',
    };
  if (task === 'missing')
    return {
      clarification: plan.kind === 'clarify' && plan.steps.length === 0,
      asksForTranscript: asksForTranscript(plan.reply),
    };

  const steps = plan.steps.join('\n');
  const checklist = plan.kind === 'plan' && plan.steps.length >= 2;
  const uses = (...paths: string[]) => paths.every((path) => steps.includes(path));
  switch (task) {
    case 'html': {
      const delivery = [...steps.matchAll(/交付|提供下载/gu)].at(-1)?.index ?? 0;
      const verified = steps
        .slice(0, delivery)
        .split(/[\n，,。；;]/u)
        .filter((clause) => /检查|预览|验证|实测|核对|打开/u.test(clause))
        .join('\n');
      return {
        checklist,
        sourceAndArtifact: uses('source/event.md', 'handout.html'),
        singleOfflineHtml:
          /单文件|单一/u.test(steps) && /离线|内嵌|无需外部资源|不依赖外部资源|无外链/u.test(steps),
        verifyAndDeliver: /375/u.test(verified) && /1440/u.test(verified) && a4.test(verified),
      };
    }
    case 'calculation':
      return {
        checklist,
        sources: uses('rules/pricing.md', 'data/products.csv'),
        filter: /active|在售/iu.test(steps),
        arithmetic: /分子|总和|总价/u.test(steps) && /分母|商品数|数量|件数/u.test(steps),
      };
    case 'readonly':
      return {
        checklist,
        sources: uses('reports/refresh.log', 'src/refresh.ts') && reading.test(steps),
        evidence: /证据|编号|引用/u.test(steps),
        readonly: !plan.steps.some((step) =>
          /^(?:先)?(?:修改|修复|执行|重建|启动)/u.test(step.trim()),
        ),
      };
    case 'revision':
      return {
        checklist,
        sourceAndArtifact: uses('release/notes.md', 'handoff.md'),
        verifyPaths:
          uses('/status', '/export') &&
          /核对|检查|验证|状态记录|查找[^。；\n]{0,80}证据/u.test(steps),
        removePdf: !steps
          .split(/[\n，。；,;]/u)
          .some(
            (clause) =>
              /(?:制作|生成|导出|交付).{0,15}PDF/iu.test(clause) && !/取消|移除|不/u.test(clause),
          ),
      };
  }
}

export function gradeDelivery(
  task: TaskId,
  delivery: Delivery,
  output: Record<string, string>,
  browser: Checks = {},
): Checks {
  const expected = trials[task].output;
  const files = {
    requestedFilesOnly:
      delivery.files.length === (expected ? 1 : 0) &&
      delivery.files.every(({ path }) => path === expected) &&
      Object.keys(output).length === (expected ? 1 : 0),
  };
  const answer = delivery.reply;
  switch (task) {
    case 'html':
      return { ...files, ...failedHtml, ...browser };
    case 'calculation':
      return {
        ...files,
        sources: answer.includes('rules/pricing.md') && answer.includes('data/products.csv'),
        numerator: reportsNumber(answer, /分子|总价|总和/u, 54),
        denominator: reportsNumber(answer, /分母|数量|件数|商品数/u, 3),
        average: reportsNumber(answer, /平均/u, 18),
      };
    case 'readonly':
      return {
        ...files,
        sources: answer.includes('reports/refresh.log') && answer.includes('src/refresh.ts'),
        evidence:
          answer.includes('RFX-731') &&
          answer.includes('batchSize') &&
          /(?:actual\s*=|batchSize[^\d\n]{0,25})\s*\b0\b/u.test(answer) &&
          /(?:最小(?:值)?|至少|大于等于|小于|阈值|min\s*=|>=|<)[^\d\n]{0,12}\b1\b/u.test(answer),
      };
    case 'missing':
      return {
        ...files,
        asksForTranscript: asksForTranscript(answer),
        noNamedDecisions: !/决议[:：]|责任人[:：]/u.test(answer),
      };
    case 'revision': {
      const markdown = output['handoff.md'] ?? '';
      const status = markdownPathEvidence(markdown, '/status');
      const exported = markdownPathEvidence(markdown, '/export');
      const accepted = /(?<!未)(?:已(?:走)?验收|已通过|验收通过)/u;
      const pending = /(?:尚)?未(?:通过|验收|核对|确认|验证)|待(?:核实|确认|验证)/u;
      return {
        ...files,
        knownPath:
          status.text.includes('GREEN-712') &&
          accepted.test(status.state) &&
          !pending.test(status.state),
        unknownPath: pending.test(exported.state) && !accepted.test(exported.state),
        groundedDate: !/\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/u.test(markdown),
      };
    }
    case 'simple':
      return { ...files, answer: answer.trim() === '22' };
  }
}
