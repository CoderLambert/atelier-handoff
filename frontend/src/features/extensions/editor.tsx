/**
 * @file 提供技能、命令和 MCP 扩展编辑表单入口。
 * @implementation 按扩展类型分派到独立的 Markdown 或 MCP 表单组件。
 * @updated 2026-11-27T21:25:00+08:00
 */
import type { Extension } from '@shared/types';
import type { ExtensionKind } from './api';
import { MarkdownExtensionForm } from './markdown-extension-form';
import { McpExtensionForm } from './mcp-extension-form';

export function ExtensionEditor({
  projectId,
  projectName,
  initialItem,
  kind,
  importFile = false,
  testOnOpen = false,
  onClose,
  onSaved,
}: {
  projectId: string;
  projectName: string;
  initialItem?: Extension;
  kind: ExtensionKind;
  importFile?: boolean;
  testOnOpen?: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  if (kind === 'mcp') {
    return (
      <McpExtensionForm
        projectId={projectId}
        projectName={projectName}
        initialItem={initialItem?.kind === 'mcp' ? initialItem : undefined}
        testOnOpen={testOnOpen}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  }
  return (
    <MarkdownExtensionForm
      projectId={projectId}
      projectName={projectName}
      initialItem={initialItem?.kind !== 'mcp' ? initialItem : undefined}
      kind={kind}
      importFile={importFile}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}
