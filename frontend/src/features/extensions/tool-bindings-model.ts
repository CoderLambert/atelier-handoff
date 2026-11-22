import { getTranslator } from '@/i18n';
import type { Extension, SkillToolBinding } from '@shared/types';
import { allowedTools } from './picker-model';

export const bindingKinds: Record<SkillToolBinding['kind'], string> = {
  get builtin() {
    return getTranslator('extensions')('bindings.builtin');
  },
  get mcp() {
    return getTranslator('extensions')('common.mcpTools');
  },
  get http() {
    return getTranslator('extensions')('bindings.https');
  },
  get command() {
    return getTranslator('extensions')('bindings.command');
  },
};
export const builtinTools = {
  get list_files() {
    return getTranslator('extensions')('bindings.listFiles');
  },
  get search_files() {
    return getTranslator('extensions')('bindings.searchFiles');
  },
  get publish_artifact() {
    return getTranslator('extensions')('bindings.publishArtifact');
  },
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
  const t = getTranslator('extensions');
  const item = items.find((value) => value.id === binding.extensionId && value.kind === 'mcp');
  if (!item || item.kind !== 'mcp') return t('bindings.mcpMissing');
  if (!item.enabled) return t('bindings.mcpDisabled');
  if (item.status !== 'connected') return t('bindings.mcpDisconnected');
  if (!item.tools.some((tool) => tool.name === binding.tool)) return t('bindings.toolMissing');
  if (!allowedTools(item, 'edit').some((tool) => tool.name === binding.tool))
    return t('bindings.toolNotAllowed');
  return '';
}

function validateHttp(binding: Extract<SkillToolBinding, { kind: 'http' }>) {
  const t = getTranslator('extensions');
  if (!bindingIdentifier.test(binding.parameter)) throw new Error(t('bindings.invalidParameter'));
  if (!binding.description.trim() || binding.description.length > 300)
    throw new Error(t('bindings.invalidDescription'));
  if (!binding.url || binding.url.length > 1000) throw new Error(t('bindings.invalidUrlLength'));
  let url: URL;
  try {
    url = new URL(binding.url);
  } catch {
    throw new Error(t('bindings.invalidUrl'));
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
    throw new Error(t('bindings.unsafeUrl'));
  const placeholders = [...binding.url.matchAll(/\{([^{}]*)\}/g)];
  if (/[{}]/.test(binding.url.replace(/\{[^{}]*\}/g, '')))
    throw new Error(t('bindings.invalidPlaceholder'));
  if (
    placeholders.length &&
    (placeholders.length !== 1 ||
      placeholders[0]![1] !== binding.parameter ||
      !url.pathname
        .split('/')
        .some((segment) => segment === encodeURIComponent(`{${binding.parameter}}`)))
  )
    throw new Error(t('bindings.placeholder', { placeholder: `{${binding.parameter}}` }));
}

export function validateBindings(bindings: SkillToolBinding[], items: Extension[]) {
  const t = getTranslator('extensions');
  if (bindings.length > maxBindings)
    throw new Error(t('bindings.maxBindings', { count: maxBindings }));
  const names = new Set<string>();
  return bindings.map((binding, index): SkillToolBinding => {
    try {
      const name = binding.name.trim();
      if (!bindingIdentifier.test(name)) throw new Error(t('bindings.invalidName'));
      if (names.has(name)) throw new Error(t('bindings.duplicateName', { name: name }));
      names.add(name);
      switch (binding.kind) {
        case 'mcp': {
          if (!binding.extensionId || !binding.tool) throw new Error(t('bindings.chooseMcpTool'));
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
        t('bindings.numberedError', {
          number: index + 1,
          error: cause instanceof Error ? cause.message : t('bindings.invalid'),
        }),
      );
    }
  });
}
