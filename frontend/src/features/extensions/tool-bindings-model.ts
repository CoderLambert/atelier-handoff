import type { Extension, SkillToolBinding } from '@shared/types';
import { allowedTools } from './picker-model';

export const bindingKinds: Record<SkillToolBinding['kind'], string> = {
  builtin: '内置工具',
  mcp: 'MCP 工具',
  http: 'HTTPS 请求',
  command: '命令预设',
};
export const builtinTools = {
  list_files: '列出项目文件',
  search_files: '搜索项目文件',
  publish_artifact: '发布产物',
} as const;
export const bindingIdentifier = /^[a-z][a-z0-9_]{0,31}$/;
export const maxBindings = 10;

export function newBinding(kind: SkillToolBinding['kind'], name = ''): SkillToolBinding {
  switch (kind) {
    case 'builtin':
      return { name, kind, tool: 'list_files' };
    case 'mcp':
      return { name, kind, extensionId: '', tool: '' };
    case 'http':
      return { name, kind, url: '', parameter: 'location', description: '' };
    case 'command':
      return { name, kind, preset: 'pdftotext' };
  }
}

export function mcpBindingIssue(
  binding: Extract<SkillToolBinding, { kind: 'mcp' }>,
  items: Extension[],
) {
  const item = items.find((value) => value.id === binding.extensionId && value.kind === 'mcp');
  if (!item || item.kind !== 'mcp') return 'MCP 服务未安装或已移除，请重新选择。';
  if (!item.enabled) return 'MCP 服务已停用，请先在项目扩展中启用。';
  if (item.status !== 'connected') return 'MCP 服务尚未连接，请先在项目扩展中测试连接。';
  if (!item.tools.some((tool) => tool.name === binding.tool))
    return '工具已不在发现结果中，请重新测试连接或选择其他工具。';
  if (!allowedTools(item, 'edit').some((tool) => tool.name === binding.tool))
    return '项目尚未允许此工具或已撤销权限，请先在 MCP 配置中允许。';
  return '';
}

function validateHttp(binding: Extract<SkillToolBinding, { kind: 'http' }>) {
  if (!bindingIdentifier.test(binding.parameter))
    throw new Error('参数名须以小写字母开头，仅含小写字母、数字和下划线，最多 32 个字符。');
  if (!binding.description.trim() || binding.description.length > 300)
    throw new Error('请填写 1–300 个字符的输入描述。');
  if (!binding.url || binding.url.length > 1000)
    throw new Error('请填写不超过 1000 个字符的固定 HTTPS URL。');
  let url: URL;
  try {
    url = new URL(binding.url);
  } catch {
    throw new Error('请输入完整的固定 HTTPS URL。');
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !url.hostname.includes('.') ||
    url.hostname.startsWith('[') ||
    /^[\d.]+$/.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname)
  )
    throw new Error('URL 须使用公开域名、HTTPS 默认端口，且不能含账号、密码或片段。');
  const placeholders = [...binding.url.matchAll(/\{([^{}]*)\}/g)];
  if (/[{}]/.test(binding.url.replace(/\{[^{}]*\}/g, '')))
    throw new Error('URL 占位符格式不正确。');
  if (
    placeholders.length &&
    (placeholders.length !== 1 ||
      placeholders[0]![1] !== binding.parameter ||
      !url.pathname
        .split('/')
        .some((segment) => segment === encodeURIComponent(`{${binding.parameter}}`)))
  )
    throw new Error(`URL 只能在完整路径段中使用一次 {${binding.parameter}} 占位符。`);
}

export function validateBindings(bindings: SkillToolBinding[], items: Extension[]) {
  if (bindings.length > maxBindings) throw new Error(`每个 Skill 最多绑定 ${maxBindings} 个工具。`);
  const names = new Set<string>();
  return bindings.map((binding, index): SkillToolBinding => {
    try {
      const name = binding.name.trim();
      if (!bindingIdentifier.test(name))
        throw new Error('名称须以小写字母开头，仅含小写字母、数字和下划线，最多 32 个字符。');
      if (names.has(name)) throw new Error(`名称 ${name} 重复，请使用唯一名称。`);
      names.add(name);
      switch (binding.kind) {
        case 'mcp': {
          if (!binding.extensionId || !binding.tool) throw new Error('请选择 MCP 服务和工具。');
          const issue = mcpBindingIssue(binding, items);
          if (issue) throw new Error(issue);
          return { name, kind: binding.kind, extensionId: binding.extensionId, tool: binding.tool };
        }
        case 'http': {
          const result = {
            ...binding,
            name,
            url: binding.url.trim(),
            parameter: binding.parameter.trim(),
            description: binding.description.trim(),
          };
          validateHttp(result);
          return result;
        }
        case 'builtin':
          return { name, kind: binding.kind, tool: binding.tool };
        case 'command':
          return { name, kind: binding.kind, preset: 'pdftotext' };
      }
    } catch (cause) {
      throw new Error(
        `第 ${index + 1} 个绑定：${cause instanceof Error ? cause.message : '配置无效。'}`,
      );
    }
  });
}
