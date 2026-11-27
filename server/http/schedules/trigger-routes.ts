/**
 * @file 提供最小权限的单任务远程触发窄口 HTTP 路由。
 * @implementation 仅暴露 POST /api/triggers/schedules/:idOrSlug，校验单任务独立 Bearer Token 与滑动窗口限流后转调统一触发漏斗。
 * @updated 2026-11-27T15:10:00+08:00
 */
import type { IncomingMessage } from 'node:http';
import { AppError } from '../../../shared/errors.js';
import {
  SCHEDULE_REMOTE_RATE_LIMIT_PER_MINUTE,
  triggerScheduledTaskBodySchema,
  type TriggerScheduledTaskBody,
} from '../../../shared/schedules.js';
import type { ScheduleScheduler } from '../../modules/schedules/scheduler.js';
import type { ScheduleService } from '../../modules/schedules/service.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

const RATE_WINDOW_MS = 60_000;

export async function readOptionalTriggerBody(
  req: IncomingMessage,
): Promise<TriggerScheduledTaskBody> {
  if (!req.headers['content-type']?.startsWith('application/json')) return {};
  return triggerScheduledTaskBodySchema.parse(await body(req, 64_000));
}

export function extractIdempotencyKeyHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers['idempotency-key'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 160);
  return undefined;
}

function extractBearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string') return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(raw.trim());
  return match?.[1] ?? null;
}

export function createScheduleTriggerRoutes(
  service: Pick<ScheduleService, 'verifyTriggerToken'>,
  scheduler: Pick<ScheduleScheduler, 'trigger'>,
  options?: { rateLimitPerMinute?: number; now?: () => number },
): RouteHandler {
  const limit = options?.rateLimitPerMinute ?? SCHEDULE_REMOTE_RATE_LIMIT_PER_MINUTE;
  const now = options?.now ?? (() => Date.now());
  const hitsByTask = new Map<string, number[]>();

  function checkRateLimit(taskId: string): void {
    const current = now();
    const cutoff = current - RATE_WINDOW_MS;
    const recent = (hitsByTask.get(taskId) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= limit) {
      hitsByTask.set(taskId, recent);
      throw new AppError(
        'RATE_LIMITED',
        `该任务远程触发过于频繁（每分钟最多 ${limit} 次），请稍后重试。`,
        429,
      );
    }
    recent.push(current);
    hitsByTask.set(taskId, recent);
  }

  return async ({ req, res, parts, method }) => {
    const [api, triggers, resource, idOrSlug] = parts;
    if (api !== 'api' || triggers !== 'triggers' || resource !== 'schedules') return false;
    if (parts.length !== 4 || !idOrSlug || method !== 'POST') {
      throw new AppError('NOT_FOUND', '接口不存在。', 404);
    }

    const token = extractBearerToken(req);
    if (!token) {
      throw new AppError('UNAUTHORIZED', '缺少有效的 Bearer 触发令牌。', 401);
    }
    const task = service.verifyTriggerToken(idOrSlug, token);
    if (!task) {
      throw new AppError('UNAUTHORIZED', '触发令牌无效或该任务未启用远程触发。', 401);
    }
    checkRateLimit(task.id);

    const parsed = await readOptionalTriggerBody(req);
    const idempotencyKey = parsed.idempotencyKey ?? extractIdempotencyKeyHeader(req);
    const result = await scheduler.trigger(task.id, {
      triggerKind: 'webhook',
      projectId: task.projectId,
      input: parsed.input,
      idempotencyKey,
      triggerSource: 'webhook',
      allowPaused: false,
    });
    return json(res, result, result.deduplicated ? 200 : 201);
  };
}
