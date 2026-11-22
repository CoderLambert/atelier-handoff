/**
 * @file 请求当前网关的托管网页搜索，并验证结果网址。
 * @implementation 绑定指定域名与当前运行的认证，读取搜索结果及引用并校验实际主机名。
 * @updated 2026-11-21T03:00:00+08:00
 */
import { z } from 'zod';
import { AppError, type AppConfig } from '../shared/types.js';
import { magpieModel } from './magpie-models.js';

export function gatewayToken(config: AppConfig) {
  if (magpieModel(config.model) !== undefined)
    return process.env.ATELIER_MAGPIE_TOKEN || 'local-placeholder';
  return (
    (config.managedGateway && config.gateway === process.env.ATELIER_MANAGED_GATEWAY
      ? process.env.ATELIER_MANAGED_GATEWAY_TOKEN
      : process.env.ATELIER_GATEWAY_TOKEN) || 'local-placeholder'
  );
}

export const gatewaySearchArgs = {
  query: z.string().trim().min(1).max(500),
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      '请填写网站域名，例如 baidu.com。',
    ),
};

const sourceSchema = z.object({
  url: z.string().max(4096),
  title: z.string().max(1000).nullable().optional(),
  cited_text: z.string().max(8000).optional(),
});
const responseSchema = z.object({
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('server_tool_use'), name: z.string() }),
      z.object({
        type: z.literal('web_search_tool_result'),
        content: z.union([z.array(z.unknown()), z.object({ error_code: z.string().optional() })]),
      }),
      z.object({
        type: z.literal('text'),
        text: z.string(),
        citations: z.array(z.unknown()).nullable().optional(),
      }),
    ]),
  ),
});

export async function searchGateway(
  config: AppConfig,
  input: z.infer<z.ZodObject<typeof gatewaySearchArgs>>,
  signal: AbortSignal,
) {
  const { query, domain } = z.object(gatewaySearchArgs).parse(input);
  const endpoint = new URL(config.gateway);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/messages`;
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    headers: {
      Authorization: `Bearer ${gatewayToken(config)}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: magpieModel(config.model) ?? config.model,
      max_tokens: 1200,
      messages: [
        {
          role: 'user',
          content: `在 ${domain} 域名范围内联网搜索。返回几条可核对的结果，每一条都必须带托管搜索给出的原始引用网址。不要使用其他网站。用户查询：${query}`,
        },
      ],
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 1, allowed_domains: [domain] },
      ],
      tool_choice: { type: 'tool', name: 'web_search' },
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      'GATEWAY_SEARCH_UNAVAILABLE',
      `当前模型网关的网页搜索失败（HTTP ${response.status}）。`,
      502,
    );
  }
  const raw: unknown = await response.json();
  signal.throwIfAborted();
  const result = responseSchema.safeParse(raw);
  if (
    !result.success ||
    !result.data.content.some(
      (block) => block.type === 'server_tool_use' && block.name === 'web_search',
    )
  ) {
    throw new AppError('GATEWAY_SEARCH_UNAVAILABLE', '当前模型网关没有返回网页搜索调用。', 502);
  }

  const sources = new Map<string, { url: string; title: string; excerpt?: string }>();
  for (const block of result.data.content) {
    if (block.type === 'web_search_tool_result' && !Array.isArray(block.content)) {
      throw new AppError('GATEWAY_SEARCH_FAILED', '当前模型网关未能完成网页搜索。', 502);
    }
    const candidates =
      block.type === 'text'
        ? (block.citations ?? [])
        : block.type === 'web_search_tool_result'
          ? block.content
          : [];
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      const source = sourceSchema.safeParse(candidate);
      if (!source.success) continue;
      let url: URL;
      try {
        url = new URL(source.data.url);
      } catch {
        continue;
      }
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        (host !== domain && !host.endsWith(`.${domain}`))
      )
        continue;
      sources.set(url.href, {
        url: url.href,
        title: source.data.title || host,
        ...(source.data.cited_text ? { excerpt: source.data.cited_text.slice(0, 800) } : {}),
      });
    }
  }
  return {
    query,
    domain,
    sources: [...sources.values()].slice(0, 12),
    ...(sources.size ? {} : { message: `已执行搜索，网关未返回可以核对的 ${domain} 域名来源。` }),
  };
}
