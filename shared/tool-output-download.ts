/**
 * @file 根据本机 Bash 日志保存范围生成工具输出下载名。
 * @implementation 桌面链接与 HTTP 下载响应使用同一组静态文件名。
 * @updated 2026-11-22T22:00:00+08:00
 */
import type { ToolCall } from './types.js';

export function toolOutputFilename(log?: ToolCall['bashLog']): string {
  if (!log) return 'tool-output.txt';
  if (log.status === 'complete') return 'bash-log.txt';
  if (log.status === 'partial') return 'bash-log-saved.txt';
  return 'bash-sdk-receipt.txt';
}
