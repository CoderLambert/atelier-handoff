/**
 * @file 提供把当前数据库降回 v10 结构的测试语句。
 * @implementation 按依赖顺序删除 v11 的状态与运行索引及派生列，供旧版本升级夹具先还原再重新迁移。
 * @updated 2026-11-27T20:15:00+08:00
 */
export const dropV11Schema = `
  DROP INDEX runs_status; DROP INDEX tools_run_status;
  DROP INDEX tools_status; DROP INDEX permissions_run_status; DROP INDEX permissions_status;
  DROP INDEX artifacts_run;
  ALTER TABLE runs DROP COLUMN status;
  ALTER TABLE tools DROP COLUMN run_id; ALTER TABLE tools DROP COLUMN status;
  ALTER TABLE permissions DROP COLUMN run_id; ALTER TABLE permissions DROP COLUMN status;
  ALTER TABLE artifacts DROP COLUMN run_id;
`;
