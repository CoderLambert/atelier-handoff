import type { Extension } from '../shared/types.js';
import { fingerprint } from './files.js';

interface SkillDefinition {
  id: string;
  name: string;
  title: string;
  description: string;
  category: '设计' | '开发' | '写作';
  publisher: string;
  repository: string;
  upstreamName: string;
  commit: string;
  sha256: string;
  license: { name: string; url: string };
  capabilities: string[];
  legacyBodyRevision?: string;
}

const anthropicCommit = 'e4bb5d960d87126ff3b3a8af1a104b7db67560ba';
const addyCommit = '39b723ceebf81474d0557c1fecd01eddab585563';
const copilotCommit = 'a255a193d1318e5a9ca3e9e575897f9a7845c099';
const definitions: SkillDefinition[] = [
  {
    id: 'frontend-design',
    name: 'frontend-design',
    title: '前端视觉设计',
    category: '设计',
    publisher: 'Anthropic',
    description: '为页面建立独特的版式、字体、色彩与交互方向，适合新界面和视觉改版。',
    repository: 'anthropics/skills',
    upstreamName: 'frontend-design',
    commit: anthropicCommit,
    sha256: 'd91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3',
    license: {
      name: 'Apache-2.0',
      url: `https://github.com/anthropics/skills/blob/${anthropicCommit}/skills/frontend-design/LICENSE.txt`,
    },
    capabilities: ['独立 Markdown 说明；实现和视觉验证使用当前项目已配置的工具。'],
  },
  {
    id: 'ui-review',
    name: 'ui-review',
    title: '界面走查',
    category: '设计',
    publisher: 'Addy Osmani',
    description: '使用真实浏览器检查页面、控制台、网络与性能，保留 /ui-review 调用名。',
    repository: 'addyosmani/agent-skills',
    upstreamName: 'browser-testing-with-devtools',
    commit: addyCommit,
    sha256: 'e28dd45416e6df93f0db6fffeb3aa2477a0e48a22f8e05fd5bb1892484115bb6',
    license: {
      name: 'MIT',
      url: `https://github.com/addyosmani/agent-skills/blob/${addyCommit}/LICENSE`,
    },
    capabilities: ['实时浏览器检查需要另行配置并授权 Chrome DevTools MCP；此 Skill 不安装工具。'],
    legacyBodyRevision: 'dde3f4387d9f397b8188ccff2aa09ac89c685b37973dc2d9d4b307bec4c60776',
  },
  {
    id: 'code-review',
    name: 'code-review',
    title: '代码审查',
    category: '开发',
    publisher: 'Addy Osmani',
    description: '从多个维度审查变更和潜在行为回归，保留 /code-review 调用名。',
    repository: 'addyosmani/agent-skills',
    upstreamName: 'code-review-and-quality',
    commit: addyCommit,
    sha256: '5dc8f98d9d23e74676091a945b2649bb52456e34f293238ee2511281104a94c0',
    license: {
      name: 'MIT',
      url: `https://github.com/addyosmani/agent-skills/blob/${addyCommit}/LICENSE`,
    },
    capabilities: ['独立 Markdown 说明；代码检查和验证使用当前项目已配置的工具。'],
    legacyBodyRevision: 'be9b9d7db44264f70df4a0716abcdbc4c56f37bcc6a32e94ed4b7328c551c01a',
  },
  {
    id: 'debug-triage',
    name: 'debug-triage',
    title: '故障定位',
    category: '开发',
    publisher: 'Addy Osmani',
    description: '按证据追踪根因、提出最小修复并验证结果，保留 /debug-triage 调用名。',
    repository: 'addyosmani/agent-skills',
    upstreamName: 'debugging-and-error-recovery',
    commit: addyCommit,
    sha256: '95e393819043b50b3ba6f4d89f0fea620d03e560eb52b592b3eb7a41836aaea1',
    license: {
      name: 'MIT',
      url: `https://github.com/addyosmani/agent-skills/blob/${addyCommit}/LICENSE`,
    },
    capabilities: ['独立 Markdown 说明；诊断依赖当前项目可用的日志和开发工具。'],
    legacyBodyRevision: 'aba214c87d5a00b9ceec9bef90680a853975063c6f3c1964a8b649e004e6e56f',
  },
  {
    id: 'test-plan',
    name: 'test-plan',
    title: '测试设计',
    category: '开发',
    publisher: 'GitHub Awesome Copilot',
    description: '形成测试策略、任务拆分和质量验收计划，保留 /test-plan 调用名。',
    repository: 'github/awesome-copilot',
    upstreamName: 'breakdown-test',
    commit: copilotCommit,
    sha256: '83727ec30a986686f1bc8eaeeb42360379c11416a280c4e77d38d39e0e02555f',
    license: {
      name: 'MIT',
      url: `https://github.com/github/awesome-copilot/blob/${copilotCommit}/LICENSE`,
    },
    capabilities: ['独立 Markdown 测试规划说明；执行测试需要项目已有的测试环境。'],
    legacyBodyRevision: '450ce07d534a14d0fab4b1f2dcd55a0eec558ee90644600997f1c6e9490b9704',
  },
  {
    id: 'doc-coauthoring',
    name: 'doc-coauthoring',
    title: '文档共创',
    category: '写作',
    publisher: 'Anthropic',
    description: '逐步收集读者和背景，起草技术说明、提案或决策文档，并检查可读性。',
    repository: 'anthropics/skills',
    upstreamName: 'doc-coauthoring',
    commit: anthropicCommit,
    sha256: '2e47d78846faeea4a56e9809c52700087a15a2155a3f293a3efbaded81398ef4',
    license: {
      name: '上游 README（未单独声明）',
      url: `https://github.com/anthropics/skills/blob/${anthropicCommit}/README.md`,
    },
    capabilities: ['独立 Markdown 文档协作说明；独立读者检查需要当前运行环境支持。'],
  },
];

export const skillMarketCatalog = Object.freeze(
  definitions.map((definition) => {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(definition.id) ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(definition.name) ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(definition.upstreamName) ||
      !/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(definition.repository) ||
      !/^[a-f0-9]{40}$/.test(definition.commit) ||
      !/^[a-f0-9]{64}$/.test(definition.sha256)
    )
      throw new Error(`Invalid skill market definition: ${definition.id}`);
    const path = `skills/${definition.upstreamName}/SKILL.md`;
    const url = `https://raw.githubusercontent.com/${definition.repository}/${definition.commit}/${path}`;
    return Object.freeze({
      ...definition,
      license: Object.freeze(definition.license),
      capabilities: Object.freeze(definition.capabilities),
      path,
      url,
      revision: fingerprint(JSON.stringify(definition)),
    });
  }),
);
if (
  new Set(skillMarketCatalog.map((skill) => skill.id)).size !== skillMarketCatalog.length ||
  new Set(skillMarketCatalog.map((skill) => skill.name)).size !== skillMarketCatalog.length
)
  throw new Error('Duplicate skill market identity or alias.');
export type MarketSkill = (typeof skillMarketCatalog)[number];

export function marketSkillById(id: string) {
  return skillMarketCatalog.find((skill) => skill.id === id);
}

export function marketSkillFromSource(location: string, key: string) {
  return skillMarketCatalog.find(
    (skill) =>
      key === skill.path &&
      (location === skill.url ||
        (skill.repository === 'anthropics/skills' &&
          location === `https://raw.githubusercontent.com/${skill.repository}/main/${skill.path}`)),
  );
}

export function identifyMarketSkill(item: Extension): MarketSkill | undefined {
  if (item.kind !== 'skill') return;
  return (
    marketSkillById(item.marketId ?? '') ??
    (item.origin && marketSkillFromSource(item.origin.location, item.origin.key)) ??
    skillMarketCatalog.find(
      (skill) => skill.legacyBodyRevision && fingerprint(item.body) === skill.legacyBodyRevision,
    )
  );
}

export function marketLocalModified(skill: MarketSkill, item: Extension) {
  if (item.kind !== 'skill') return false;
  const original = item.origin?.revision ?? skill.legacyBodyRevision;
  return !original || fingerprint(item.body) !== original;
}

export function marketCurrent(skill: MarketSkill, item: Extension) {
  return (
    item.marketId === skill.id &&
    item.marketRevision === skill.revision &&
    item.origin?.location === skill.url &&
    item.origin.key === skill.path &&
    item.origin.sha256 === skill.sha256
  );
}
