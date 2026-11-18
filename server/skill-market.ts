import { AppError, type Extension } from '../shared/types.js';
import { inspectMarkdown, ProjectExtensions } from './extensions.js';
import { previewPublic } from './public-extensions.js';

interface SkillCard {
  id: string;
  name: string;
  title: string;
  description: string;
  category: '设计' | '开发' | '写作';
  publisher: string;
}

type Skill = SkillCard & ({ url: string } | { body: string });

const catalog: Skill[] = [
  {
    id: 'frontend-design',
    name: 'frontend-design',
    title: '前端视觉设计',
    category: '设计',
    publisher: 'Anthropic',
    description: '为页面建立独特的版式、字体、色彩与交互方向，适合新界面和视觉改版。',
    url: 'https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md',
  },
  {
    id: 'ui-review',
    name: 'ui-review',
    title: '界面走查',
    category: '设计',
    publisher: 'atelier',
    description: '按实际使用路径审查视觉层级、响应式、键盘操作和交互反馈。',
    body: `先确定页面的主要任务，沿用户路径检查布局、标签、反馈、错误、键盘操作和小屏。优先指出阻止完成任务的问题。
对每条发现写明可见现象、触发步骤、影响与可验证的修正。把静态检查和浏览器实际观察分开。缺少截图或设备时，说明可确认的范围。
输出优先级排序的建议。用户要求修改时沿用现有组件和设计变量，验证桌面与窄屏的关键操作。`,
  },
  {
    id: 'code-review',
    name: 'code-review',
    title: '代码审查',
    category: '开发',
    publisher: 'atelier',
    description: '找出有具体触发条件的行为回归，按严重程度列出证据和修复方向。',
    body: `针对用户给出的变更范围审查。先理解现有契约和调用方，沿入口核对状态变化、错误处理、并发以及边界输入。确认问题是在改动中引入或暴露。
只报告具有可复现条件的发现。每条给出文件位置、触发条件、错误结果与可行修复。按严重程度排序。没有确认的问题时，直接给出结论与未验证范围。审查以只读方式进行，修改需由用户提出。`,
  },
  {
    id: 'debug-triage',
    name: 'debug-triage',
    title: '故障定位',
    category: '开发',
    publisher: 'atelier',
    description: '从日志或异常现象建立复现条件，验证最可能原因并提出最小修复。',
    body: `先区分预期、实际现象与触发条件。定位日志中的首个有信息量的错误，并沿调用边界说明它与症状的关系。
提出少量按证据排序的假设。用只读检查或最小复现排除假设，记录失败结果。确认原因后给出最小修复及一条能防止复发的验证。缺少关键证据时写清下一项观测和预期结果。`,
  },
  {
    id: 'test-plan',
    name: 'test-plan',
    title: '测试设计',
    category: '开发',
    publisher: 'atelier',
    description: '把功能变更拆成可复现的正常、失败与回归场景，注明验收结果。',
    body: `找出用户要完成的核心行为和受影响的调用方。为正常路径、高影响的失败路径、边界和重复操作选取最小的测试集合。
每个用例给出前置条件、输入或操作、可直接断言的结果，并说明适合用单元、集成还是浏览器验证。优先使用已有测试入口和真实边界。记录已经运行的检查与仅提出的用例。`,
  },
  {
    id: 'doc-coauthoring',
    name: 'doc-coauthoring',
    title: '文档共创',
    category: '写作',
    publisher: 'Anthropic',
    description: '逐步收集读者和背景，起草技术说明、提案或决策文档，并检查可读性。',
    url: 'https://raw.githubusercontent.com/anthropics/skills/main/skills/doc-coauthoring/SKILL.md',
  },
];

function installedSkill(skill: Skill, items: Extension[]) {
  return items.find(
    (item) =>
      item.kind === 'skill' &&
      (item.marketId === skill.id || ('url' in skill && item.origin?.location === skill.url)),
  );
}

export function listSkillMarket(registry: ProjectExtensions, projectId: string) {
  const items = registry.list(projectId);
  return catalog.map((skill) => {
    const installed = installedSkill(skill, items);
    const conflict =
      !installed && items.some((item) => item.kind !== 'mcp' && item.name === skill.name);
    return {
      id: skill.id,
      name: installed?.name ?? skill.name,
      title: skill.title,
      category: skill.category,
      description: skill.description,
      publisher: skill.publisher,
      url: 'url' in skill ? skill.url : undefined,
      status: installed
        ? installed.enabled
          ? 'enabled'
          : 'disabled'
        : conflict
          ? 'conflict'
          : 'available',
    };
  });
}

export async function installMarketSkill(
  registry: ProjectExtensions,
  projectId: string,
  id: string,
  fetchSkill = previewPublic,
) {
  const skill = catalog.find((item) => item.id === id);
  if (!skill) throw new AppError('MARKET_SKILL_NOT_FOUND', '精选目录中没有该 Skill。', 404);
  const activate = (item: Extension) => {
    if (item.kind !== 'skill' || !item.supported || !item.userInvocable) {
      throw new AppError(
        'EXTENSION_UNAVAILABLE',
        '项目中此 Skill 的当前版本无法手动调用。请在已安装列表检查配置。',
        409,
      );
    }
    return item.enabled
      ? item
      : registry.save(projectId, { version: item.version, enabled: true }, item.id);
  };
  const existing = installedSkill(skill, registry.list(projectId));
  if (existing) return activate(existing);
  if ('body' in skill) {
    return registry.save(
      projectId,
      {
        kind: 'skill',
        name: skill.name,
        description: skill.description,
        body: skill.body,
        enabled: true,
        source: 'atelier 精选',
      },
      undefined,
      skill.id,
    );
  }
  const [entry] = await fetchSkill(skill.url, 'skill');
  if (!entry?.body || entry.name !== skill.name || entry.location !== skill.url) {
    throw new AppError('MARKET_SKILL_SOURCE_CHANGED', '精选 Skill 的公开来源已变化。', 409);
  }
  const metadata = inspectMarkdown(entry.body);
  if (!metadata.supported || !metadata.userInvocable) {
    throw new AppError(
      'EXTENSION_UNAVAILABLE',
      metadata.compatibility || '公开 Skill 暂时无法手动调用。',
      409,
    );
  }
  const installedDuringFetch = installedSkill(skill, registry.list(projectId));
  if (installedDuringFetch) return activate(installedDuringFetch);
  return registry.savePublic(projectId, entry).item;
}
