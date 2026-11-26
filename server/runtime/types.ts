/**
 * @file 定义运行时组合入口的启动参数。
 * @implementation 保留生产、桌面宿主与隔离集成测试使用的输入及替换依赖。
 * @updated 2026-11-26T23:20:03+08:00
 */
import type { Runner } from '../agent.js';
import type { FileRecords } from '../artifacts.js';
import type { PermissionService } from '../permissions.js';
import type { pickProjectDirectory } from '../project-picker.js';
import type { Store } from '../store.js';

export interface CreateAppOptions {
  root: string;
  data: string;
  runnerFactory?: (store: Store, permissions: PermissionService, files: FileRecords) => Runner;
  permissionTtlMs?: number;
  desktopPairing?: string;
  nativeExecution?: boolean;
  magpie?: string;
  rtkBinary?: string;
  pickDirectory?: typeof pickProjectDirectory;
  publicSourceFetch?: typeof fetch;
}
