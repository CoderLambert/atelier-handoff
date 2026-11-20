/**
 * @file 读取本机 Codex 客户端公开的可见模型目录。
 * @implementation 通过有时限的 app-server stdio 握手请求模型列表，解析显示名称与支持的推理深度，并短时间复用结果。
 * @updated 2026-11-20T17:32:12+08:00
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { reasoningEfforts, type GatewayModelCatalog } from '../shared/types.js';

type Models = GatewayModelCatalog['models'];
const listedModels = z.object({
  data: z.array(
    z.object({
      model: z.string().max(200).regex(/^\S+$/u),
      displayName: z.string().min(1).max(200),
      hidden: z.boolean().optional(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).optional(),
    }),
  ),
});
let cached: { expiresAt: number; models: Promise<Models> } | undefined;

function fetchCodexModelCatalog(): Promise<Models> {
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    const deadline = setTimeout(() => finish([]), 5000);
    function finish(models: Models) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      lines.close();
      child.stdin.end();
      child.kill();
      resolve(models);
    }
    function send(message: object) {
      child.stdin.write(JSON.stringify(message) + '\n');
    }
    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));
    child.stdin.on('error', () => finish([]));
    lines.on('line', (line) => {
      try {
        const message = z
          .object({ id: z.number(), result: z.unknown().optional() })
          .safeParse(JSON.parse(line));
        // Notifications and requests initiated by Codex are unrelated to this lookup.
        if (!message.success) return;
        if (message.data.id === 1) {
          if (message.data.result === undefined) return finish([]);
          send({ method: 'initialized' });
          send({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: false } });
        }
        if (message.data.id === 2) {
          const { data } = listedModels.parse(message.data.result);
          finish(
            data
              .filter((entry) => !entry.hidden)
              .map((entry) => ({
                id: entry.model,
                displayName: entry.displayName,
                supportedEfforts: entry.supportedReasoningEfforts
                  ? reasoningEfforts.filter((level) =>
                      entry.supportedReasoningEfforts?.some(
                        (value) => value.reasoningEffort === level,
                      ),
                    )
                  : undefined,
                provider: 'chatgpt-plan',
              })),
          );
        }
      } catch {
        finish([]);
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'atelier', version: '0.2.0' } },
    });
  });
}

export function codexModelCatalog(): Promise<Models> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;
  const models = fetchCodexModelCatalog();
  cached = { models, expiresAt: now + 60_000 };
  return models;
}
