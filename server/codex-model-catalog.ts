/**
 * @file 读取本机 Codex 客户端公开的可见模型目录。
 * @implementation 通过有时限的 app-server stdio 握手请求模型列表，解析显示名称与支持的推理深度，并短时间复用结果。
 * @updated 2026-11-23T18:25:00+08:00
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { reasoningEfforts, type GatewayModelCatalog } from '../shared/types.js';

type Models = GatewayModelCatalog['models'];
type Discovery = GatewayModelCatalog['discovery']['codex'];
export interface CodexCatalogRequest {
  source: string;
  refresh?: boolean;
}
export interface CodexCatalogResult {
  models: Models;
  discovery: Discovery;
}

interface CodexCatalogCacheEntry {
  result?: CodexCatalogResult;
  success?: { models: Models; at: number };
  nextAttemptAt: number;
  failures: number;
  pending?: Promise<CodexCatalogResult>;
}
const model = z.object({
  model: z.string().max(200).regex(/^\S+$/u),
  displayName: z.string().min(1).max(200).optional(),
  hidden: z.boolean().optional(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).optional(),
});
const page = z.object({
  data: z.array(z.unknown()),
  nextCursor: z.string().min(1).max(4096).nullable().optional(),
});
const envelope = z.object({ id: z.number(), result: z.unknown().optional() });
const successTtlMs = 60_000;
const staleTtlMs = 5 * 60_000;
const maxSources = 8;
const maxPages = 20;

/** Fingerprint file metadata only: credential contents never enter this process or cache. */
async function localIdentity(): Promise<string | undefined> {
  // Environment-provided auth has no observable file revision; don't reuse it across requests.
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return undefined;
  const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  async function revision(path: string) {
    try {
      const value = await stat(path, { bigint: true });
      return [path, value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${path}:absent`;
      throw error;
    }
  }
  try {
    const parts = await Promise.all([
      revision(join(home, 'auth.json')),
      revision(join(home, 'config.toml')),
    ]);
    if (parts[0]?.endsWith(':absent')) return undefined;
    const accounts = process.env.SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR;
    if (accounts) {
      parts.push(await revision(accounts));
      const names = (await readdir(accounts)).filter((name) => name.endsWith('.json')).sort();
      parts.push(...(await Promise.all(names.map((name) => revision(join(accounts, name))))));
    }
    return createHash('sha256').update(parts.join('\n')).digest('hex');
  } catch {
    return undefined;
  }
}

function fetchCodexModelCatalog(
  start: () => ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<CodexCatalogResult> {
  return new Promise((resolveCatalog) => {
    const models = new Map<string, Models[number]>();
    let rejectedCount = 0;
    let pages = 0;
    let requestId = 1;
    let initialized = false;
    const cursors = new Set<string>();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = start();
    } catch {
      return resolveCatalog({
        models: [],
        discovery: { status: 'unavailable', reason: 'process', modelCount: 0 },
      });
    }
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    const deadline = setTimeout(() => finish('timeout'), timeoutMs);
    function finish(reason?: Discovery['reason']) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      lines.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const kill = setTimeout(() => child.kill('SIGKILL'), 250);
        kill.unref();
        child.once('close', () => clearTimeout(kill));
      }
      resolveCatalog({
        models: [...models.values()],
        discovery: {
          status: reason || rejectedCount ? (models.size ? 'partial' : 'unavailable') : 'ready',
          ...(reason ? { reason } : rejectedCount ? { reason: 'protocol' as const } : {}),
          modelCount: models.size,
          ...(rejectedCount ? { rejectedCount } : {}),
        },
      });
    }
    function send(message: object) {
      if (finished) return;
      try {
        child.stdin.write(JSON.stringify(message) + '\n');
      } catch {
        finish('process');
      }
    }
    function nextPage(cursor?: string) {
      requestId++;
      send({
        id: requestId,
        method: 'model/list',
        params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
      });
    }
    child.on('error', () => finish('process'));
    // `exit` can precede stdout draining; the last page must be read before treating exit as failure.
    child.on('close', () => finish('process'));
    child.stdin.on('error', () => finish('process'));
    child.stdout.on('error', () => finish('process'));
    child.stderr.resume();
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) finish('protocol');
    });
    lines.on('line', (line) => {
      if (finished) return;
      try {
        const message = envelope.safeParse(JSON.parse(line));
        // Ignore notifications and server-initiated requests unrelated to this lookup.
        if (!message.success || message.data.id !== requestId) return;
        if (!initialized) {
          if (!z.object({}).safeParse(message.data.result).success) return finish('protocol');
          initialized = true;
          send({ method: 'initialized' });
          nextPage();
          return;
        }
        const parsed = page.safeParse(message.data.result);
        if (!parsed.success) return finish('protocol');
        pages++;
        for (const entry of parsed.data.data) {
          const parsedModel = model.safeParse(entry);
          if (!parsedModel.success) {
            rejectedCount++;
            continue;
          }
          const value = parsedModel.data;
          if (value.hidden) continue;
          const efforts = value.supportedReasoningEfforts;
          if (models.size >= 2000 && !models.has(value.model)) return finish('pagination-limit');
          models.set(value.model, {
            ...models.get(value.model),
            id: value.model,
            ...(value.displayName ? { displayName: value.displayName } : {}),
            ...(efforts
              ? {
                  supportedEfforts: reasoningEfforts.filter((level) =>
                    efforts.some((effort) => effort.reasoningEffort === level),
                  ),
                }
              : {}),
            provider: 'chatgpt-plan',
          });
        }
        const cursor = parsed.data.nextCursor;
        if (!cursor) return finish();
        if (pages >= maxPages || cursors.has(cursor)) return finish('pagination-limit');
        cursors.add(cursor);
        nextPage(cursor);
      } catch {
        finish('protocol');
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'atelier', version: '0.2.0' } },
    });
  });
}

/** Each loader owns its bounded cache; tests inject only process, clock, and metadata identity. */
export function createCodexModelCatalog(
  options: {
    start?: () => ChildProcessWithoutNullStreams;
    identity?: () => Promise<string | undefined>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
) {
  const start = options.start ?? (() => spawn('codex', ['app-server', '--stdio']));
  const identity = options.identity ?? localIdentity;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CodexCatalogCacheEntry>();
  let active = 0;
  return async (request: CodexCatalogRequest): Promise<CodexCatalogResult> => {
    const before = await identity();
    const key = before ? JSON.stringify([request.source, before]) : undefined;
    let entry = key ? cache.get(key) : undefined;
    if (entry?.pending) return entry.pending;
    if (entry?.result && entry.nextAttemptAt > now()) {
      const expiredStale =
        entry.result.discovery.status === 'stale' &&
        entry.success !== undefined &&
        now() - entry.success.at > staleTtlMs;
      if (!expiredStale && (!request.refresh || entry.result.discovery.status !== 'ready'))
        return entry.result;
    }
    if (active >= maxSources)
      return { models: [], discovery: { status: 'unavailable', reason: 'process', modelCount: 0 } };
    if (!entry) {
      // Don't evict an active process: exhausting all slots returns an explicit bounded failure.
      if (key && cache.size >= maxSources) {
        const oldest = [...cache].find(([, value]) => !value.pending);
        if (!oldest)
          return {
            models: [],
            discovery: { status: 'unavailable', reason: 'process', modelCount: 0 },
          };
        cache.delete(oldest[0]);
      }
      entry = { nextAttemptAt: 0, failures: 0 };
      if (key) cache.set(key, entry);
    }
    const current = entry;
    const pending = (async () => {
      active++;
      // Codex's own offline catalog fallback can spend five seconds refreshing first.
      const result = await fetchCodexModelCatalog(start, options.timeoutMs ?? 10_000).finally(
        () => {
          active--;
        },
      );
      if ((await identity()) !== before) {
        if (key) cache.delete(key);
        return {
          models: [],
          discovery: { status: 'unavailable', reason: 'identity', modelCount: 0 },
        } satisfies CodexCatalogResult;
      }
      const at = now();
      if (result.discovery.status === 'ready') {
        current.success = { models: result.models, at };
        current.failures = 0;
        current.nextAttemptAt = at + successTtlMs;
      } else {
        current.nextAttemptAt = at + Math.min(2000 * 2 ** current.failures++, 15_000);
        if (key && current.success && at - current.success.at <= staleTtlMs) {
          const merged = new Map(current.success.models.map((value) => [value.id, value]));
          for (const value of result.models) merged.set(value.id, value);
          result.models = [...merged.values()];
          result.discovery = {
            ...result.discovery,
            status: 'stale',
            modelCount: result.models.length,
          };
        }
      }
      current.result = result;
      return result;
    })();
    current.pending = pending;
    try {
      return await pending;
    } finally {
      current.pending = undefined;
    }
  };
}

export const codexModelCatalog = createCodexModelCatalog();
