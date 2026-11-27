/**
 * @file 定义共享应用错误类型和统一时间戳辅助方法。
 * @implementation 保持零第三方与零内部依赖，供仅需抛出或生成时间的服务端和前端模块直接引用。
 * @updated 2026-11-27T21:25:00+08:00
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export const now = () => new Date().toISOString();
