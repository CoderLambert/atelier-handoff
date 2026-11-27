/**
 * @file 提供迁入旧工作台数据的离线命令入口。
 * @implementation 解析来源和目标，输出校验通过后的记录数和回退副本位置。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { AppError } from '../shared/errors.js';
import { migrateWorkspace } from './data-migration.js';

const [source, target, ...rest] = process.argv.slice(2);
if (!source || !target || rest.length > 0) {
  console.error(
    'Usage: migrate-data <absolute legacy data directory> <absolute new data directory>',
  );
  process.exitCode = 2;
} else {
  try {
    console.log(JSON.stringify(await migrateWorkspace(source, target)));
  } catch (error) {
    const message = error instanceof Error ? error.message : '迁入工作台数据失败。';
    console.error(error instanceof AppError ? error.code + ' ' + message : message);
    process.exitCode = 1;
  }
}
