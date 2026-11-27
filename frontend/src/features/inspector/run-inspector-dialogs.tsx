/**
 * @file 执行输出与审批的共享弹窗宿主。
 * @implementation 按需加载两种弹窗，由调用方保留加载反馈及选中记录的所有权。
 * @updated 2026-11-27T19:30:00+08:00
 */
import { lazy, Suspense, type ReactNode } from 'react';
import type { Permission, ToolCall } from '@shared/types';
import { permissionSubagentSource } from './subagent-progress-model';

const ToolOutputDialog = lazy(() => import('./tool-output-dialog'));
const PermissionDialog = lazy(() => import('./permission-dialog'));

export function RunInspectorDialogs({
  source,
  permission,
  outputTool,
  approvalFallback,
  outputFallback,
  onCloseApproval,
  onCloseOutput,
  outputFirst,
}: {
  source: Parameters<typeof permissionSubagentSource>[0];
  permission?: Permission;
  outputTool?: ToolCall;
  approvalFallback: ReactNode;
  outputFallback?: ReactNode;
  onCloseApproval: () => void;
  onCloseOutput?: () => void;
  outputFirst?: boolean;
}) {
  const approval = permission ? (
    <Suspense key="approval" fallback={approvalFallback}>
      <PermissionDialog
        key={permission.id}
        permission={permission}
        subagent={permissionSubagentSource(source, permission)}
        onOpenChange={(open) => {
          if (!open) onCloseApproval();
        }}
      />
    </Suspense>
  ) : null;
  const output = outputTool ? (
    <Suspense key="output" fallback={outputFallback}>
      <ToolOutputDialog
        key={outputTool.id}
        tool={outputTool}
        onOpenChange={(open) => {
          if (!open) onCloseOutput?.();
        }}
      />
    </Suspense>
  ) : null;
  return outputFirst ? [output, approval] : [approval, output];
}
