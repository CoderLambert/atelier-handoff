/**
 * @file 定义 MCP 编辑器中的共享和自动提供工具选项。
 * @implementation 仅允许 stdio MCP 共享，且共享时始终关闭自动提供工具。
 * @updated 2026-11-27T00:00:00+08:00
 */
import type { McpTransport } from '@shared/types';

export function mcpChatOptions(
  transport: McpTransport['type'],
  share: boolean,
  autoUseInChat: boolean,
) {
  const shareAcrossProjects = transport === 'stdio' && share;
  // Send false explicitly so a PATCH clears previously enabled sharing.
  return { shareAcrossProjects, autoUseInChat: !shareAcrossProjects && autoUseInChat };
}
