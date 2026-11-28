/**
 * @file 桌面端通道模块访问本地 Atelier Server HTTP API 的客户端。
 * @implementation 自动携带桌面配对头与 CSRF 令牌，提供绑定、会话映射、项目与会话创建的受限访问。
 * @updated 2026-11-28T11:10:00+08:00
 */
import { z } from 'zod';
import {
  channelBindingSchema,
  channelSessionMappingSchema,
  type ChannelBinding,
  type ChannelId,
  type ChannelSessionMapping,
} from '../../shared/channels.js';
import { desktopPairingHeader } from '../../shared/desktop-host.js';

export interface RuntimeConnectionInfo {
  origin: string;
  pairing: string;
}

const bootstrapSummarySchema = z.object({
  csrfToken: z.string().min(1),
  projects: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        path: z.string(),
      }),
    )
    .default([]),
});

const createdSessionResponseSchema = z.object({
  session: z.object({
    id: z.string().min(1),
    projectId: z.string().min(1),
  }),
});

export class ChannelServerClient {
  private csrfToken: string | undefined;
  private cachedOrigin: string | undefined;

  constructor(private readonly getConnection: () => RuntimeConnectionInfo | undefined) {}

  private requireConnection(): RuntimeConnectionInfo {
    const conn = this.getConnection();
    if (!conn) throw new Error('Atelier 后端服务尚未就绪。');
    if (this.cachedOrigin !== conn.origin) {
      this.cachedOrigin = conn.origin;
      this.csrfToken = undefined;
    }
    return conn;
  }

  async fetchBootstrap(): Promise<z.infer<typeof bootstrapSummarySchema>> {
    const conn = this.requireConnection();
    const res = await fetch(new URL('/api/bootstrap', conn.origin), {
      headers: { [desktopPairingHeader]: conn.pairing },
    });
    if (!res.ok) throw new Error(`获取 Atelier 工作区信息失败（HTTP ${res.status}）。`);
    const parsed = bootstrapSummarySchema.parse(await res.json());
    this.csrfToken = parsed.csrfToken;
    return parsed;
  }

  private async ensureCsrfToken(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    const bootstrap = await this.fetchBootstrap();
    return bootstrap.csrfToken;
  }

  async requestJson<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    payload?: unknown,
    retryOnToken = true,
  ): Promise<T> {
    const conn = this.requireConnection();
    const headers: Record<string, string> = {
      [desktopPairingHeader]: conn.pairing,
    };
    if (method !== 'GET') {
      headers['x-atelier-token'] = await this.ensureCsrfToken();
      if (payload !== undefined) headers['content-type'] = 'application/json';
    }
    const res = await fetch(new URL(path, conn.origin), {
      method,
      headers,
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
    if (res.status === 403 && retryOnToken && method !== 'GET') {
      this.csrfToken = undefined;
      return this.requestJson<T>(method, path, payload, false);
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const err = (await res.json()) as { error?: { message?: string } };
        if (err?.error?.message) message = err.error.message;
      } catch {
        // Ignore parse failure
      }
      throw new Error(message);
    }
    return (await res.json()) as T;
  }

  async listBindings(channel?: ChannelId): Promise<ChannelBinding[]> {
    const query = channel ? `?channel=${encodeURIComponent(channel)}` : '';
    const data = await this.requestJson<{ items: unknown[] }>(
      'GET',
      `/api/channels/bindings${query}`,
    );
    return z.array(channelBindingSchema).parse(data.items);
  }

  async upsertBinding(input: {
    id: string;
    channel: ChannelId;
    chatId: string;
    label: string;
    username: string | null;
  }): Promise<ChannelBinding> {
    const data = await this.requestJson<{ binding: unknown }>(
      'POST',
      '/api/channels/bindings',
      input,
    );
    return channelBindingSchema.parse(data.binding);
  }

  async deleteBinding(channel: ChannelId, chatId: string): Promise<boolean> {
    const data = await this.requestJson<{ deleted: boolean }>(
      'DELETE',
      `/api/channels/bindings/${encodeURIComponent(channel)}/${encodeURIComponent(chatId)}`,
    );
    return Boolean(data.deleted);
  }

  async getChannelSession(
    channel: ChannelId,
    chatId: string,
  ): Promise<ChannelSessionMapping | null> {
    const data = await this.requestJson<{ session: unknown | null }>(
      'GET',
      `/api/channels/sessions/${encodeURIComponent(channel)}/${encodeURIComponent(chatId)}`,
    );
    return data.session ? channelSessionMappingSchema.parse(data.session) : null;
  }

  async upsertChannelSession(input: {
    channel: ChannelId;
    chatId: string;
    atelierSessionId: string;
    workspacePath: string;
    projectId: string;
  }): Promise<ChannelSessionMapping> {
    const data = await this.requestJson<{ session: unknown }>(
      'PUT',
      '/api/channels/sessions',
      input,
    );
    return channelSessionMappingSchema.parse(data.session);
  }

  async deleteChannelSession(channel: ChannelId, chatId: string): Promise<boolean> {
    const data = await this.requestJson<{ deleted: boolean }>(
      'DELETE',
      `/api/channels/sessions/${encodeURIComponent(channel)}/${encodeURIComponent(chatId)}`,
    );
    return Boolean(data.deleted);
  }

  async getDefaultWorkspace(): Promise<{ projectId: string; workspacePath: string } | null> {
    const bootstrap = await this.fetchBootstrap();
    const first = bootstrap.projects[0];
    if (!first) return null;
    return { projectId: first.id, workspacePath: first.path };
  }

  async createAtelierSession(
    projectId: string,
    title: string,
  ): Promise<{ id: string; projectId: string }> {
    const data = await this.requestJson<unknown>('POST', '/api/sessions', {
      projectId,
      title,
    });
    return createdSessionResponseSchema.parse(data).session;
  }
}
