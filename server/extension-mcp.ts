import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AppError, type DiscoveredTool } from '../shared/types.js';
import type { EnabledMcp } from './extensions.js';

export const MCP_CONNECT_TIMEOUT = 8_000;
const MCP_CALL_TIMEOUT = 30_000;

function configurationError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (
    error instanceof UnauthorizedError ||
    /\b(?:401|403)\b/.test(error instanceof Error ? error.message : '')
  ) {
    return new AppError('MCP_AUTH_REQUIRED', 'MCP 服务要求有效的凭据。', 401);
  }
  return new AppError(
    'MCP_CONNECTION_FAILED',
    'MCP 连接或调用失败。请检查地址、进程参数和服务端日志。',
    502,
  );
}

function createConnection(server: EnabledMcp, cwd: string) {
  const config = server.transport;
  const client = new Client({ name: 'atelier', version: '0.2.0' });
  const secrets: string[] = [];
  const readEnv = (key: string) => {
    const value = process.env[key];
    if (!value) throw new AppError('MCP_AUTH_REQUIRED', `请在本机服务环境中设置 ${key}。`, 401);
    secrets.push(value);
    return value;
  };
  const transport =
    config.type === 'http'
      ? new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: {
            headers: config.tokenEnv ? { Authorization: `Bearer ${readEnv(config.tokenEnv)}` } : {},
          },
          fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
          reconnectionOptions: {
            maxReconnectionDelay: 0,
            initialReconnectionDelay: 0,
            reconnectionDelayGrowFactor: 1,
            maxRetries: 0,
          },
        })
      : new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: Object.fromEntries(config.envNames.map((key) => [key, readEnv(key)])),
          cwd,
          stderr: 'ignore',
          maxBufferSize: 1024 * 1024,
        });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= client.close().catch(() => {}));
  return { client, transport, secrets, close };
}

type Connection = ReturnType<typeof createConnection>;
type Session = {
  transportKey: string;
  connection?: Connection;
  tail: Promise<unknown>;
};

export class McpSessions {
  private readonly sessions = new Map<string, Session>();

  async close(id: string) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    await session?.connection?.close();
  }

  async shutdown() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  async use<T>(
    server: EnabledMcp,
    cwd: string,
    signal: AbortSignal,
    work: (client: Client, secrets: string[]) => Promise<T>,
    verify?: () => void,
  ): Promise<T> {
    signal.throwIfAborted();
    verify?.();
    const id = server.id;
    const transportKey = JSON.stringify([server.projectId, cwd, server.transport]);
    let session = this.sessions.get(id);
    if (session && session.transportKey !== transportKey) {
      await this.close(id);
      return this.use(server, cwd, signal, work, verify);
    }
    if (!session) {
      if (this.sessions.size >= 8)
        throw new AppError(
          'MCP_SESSION_LIMIT',
          '已打开 8 个常驻 MCP。停用不再使用的服务后重试。',
          409,
        );
      session = { transportKey, tail: Promise.resolve() };
      this.sessions.set(id, session);
    }
    const entry = session;
    const execute = entry.tail
      .catch(() => undefined)
      .then(async () => {
        signal.throwIfAborted();
        verify?.();
        if (this.sessions.get(id) !== entry)
          throw new AppError('MCP_SESSION_CLOSED', 'MCP 会话已关闭，请重新发起工具调用。', 409);
        try {
          if (!entry.connection) {
            const connection = createConnection(server, cwd);
            entry.connection = connection;
            connection.client.onclose = () => {
              if (this.sessions.get(id) === entry) this.sessions.delete(id);
            };
            await connection.client.connect(connection.transport, {
              timeout: MCP_CONNECT_TIMEOUT,
              signal,
            });
          }
          signal.throwIfAborted();
          return await work(entry.connection.client, entry.connection.secrets);
        } catch (error) {
          if (!(error instanceof AppError) && this.sessions.get(id) === entry) await this.close(id);
          signal.throwIfAborted();
          throw configurationError(error);
        }
      });
    entry.tail = execute;
    return execute;
  }
}

async function useClient<T>(
  server: EnabledMcp,
  cwd: string,
  signal: AbortSignal,
  work: (client: Client, secrets: string[]) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const { client, transport, secrets, close } = createConnection(server, cwd);
  const abort = () => {
    void close();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT, signal });
    signal.throwIfAborted();
    return await work(client, secrets);
  } catch (error) {
    signal.throwIfAborted();
    throw configurationError(error);
  } finally {
    signal.removeEventListener('abort', abort);
    await close();
  }
}

async function discover(client: Client, signal: AbortSignal): Promise<DiscoveredTool[]> {
  const tools = new Map<string, DiscoveredTool>();
  let cursor: string | undefined;
  const visited = new Set<string>();
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: MCP_CONNECT_TIMEOUT,
      signal,
    });
    for (const tool of page.tools) {
      if (tools.size >= 100) break;
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) continue;
      const schema = JSON.stringify(tool.inputSchema);
      tools.set(tool.name, {
        name: tool.name,
        description: (tool.description ?? '').slice(0, 500),
        ...(schema.length <= 8000 ? { inputSchema: tool.inputSchema } : {}),
      });
    }
    cursor = page.nextCursor;
    if (!cursor || visited.has(cursor)) break;
    visited.add(cursor);
  } while (visited.size < 8 && tools.size < 100);
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function testMcp(
  server: EnabledMcp,
  cwd: string,
  signal: AbortSignal,
): Promise<Pick<EnabledMcp, 'status' | 'statusMessage' | 'tools'>> {
  try {
    const tools = await useClient(server, cwd, signal, async (client, secrets) => {
      const definitions = await discover(client, signal);
      // Remote tool metadata is displayable data. Never echo configured secret values.
      const encoded = JSON.stringify(definitions);
      if (secrets.some((secret) => encoded.includes(JSON.stringify(secret).slice(1, -1)))) {
        throw new AppError(
          'MCP_TOOL_METADATA_INVALID',
          'MCP 工具描述包含配置中的凭据，请修改服务端工具定义。',
          502,
        );
      }
      return definitions;
    });
    return { status: 'connected', tools, statusMessage: `已发现 ${tools.length} 项工具。` };
  } catch (error) {
    const e = configurationError(error);
    return {
      status: e.code === 'MCP_AUTH_REQUIRED' ? 'needs-auth' : 'failed',
      tools: [],
      statusMessage: e.message,
    };
  }
}

export async function callMcp(
  server: EnabledMcp,
  cwd: string,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  beforeCall?: () => void,
  sessions?: McpSessions,
): Promise<string> {
  if (!server.allowedTools.some((tool) => tool.name === name))
    throw new AppError('MCP_TOOL_NOT_ALLOWED', '当前运行未选择此工具。', 403);
  const work = async (client: Client, secrets: string[]) => {
    const discovered = await discover(client, signal);
    const current = discovered.find((tool) => tool.name === name);
    const expected = server.tools.find((tool) => tool.name === name);
    if (
      !current ||
      !expected ||
      JSON.stringify(current.inputSchema) !== JSON.stringify(expected.inputSchema)
    ) {
      throw new AppError('MCP_TOOL_CHANGED', '工具定义已变化。请重新测试连接并检查工具权限。', 409);
    }
    beforeCall?.();
    const response = await client.callTool({ name, arguments: args }, CallToolResultSchema, {
      timeout: MCP_CALL_TIMEOUT,
      signal,
    });
    const result = CallToolResultSchema.parse(response);
    signal.throwIfAborted();
    const blocks = result.content.map((block) =>
      block.type === 'text' ? block.text : `[MCP ${block.type}]`,
    );
    if (result.structuredContent && !result.content.some((block) => block.type === 'text')) {
      blocks.push(JSON.stringify(result.structuredContent));
    }
    let text = blocks.join('\n');
    for (const secret of secrets) text = text.replaceAll(secret, '[已隐藏]');
    if (result.isError)
      throw new AppError(
        'MCP_TOOL_FAILED',
        `MCP 服务报告工具执行失败。${text ? '\n' + text.slice(0, 1500) : ''}`,
        502,
      );
    return text.length > 32000 ? text.slice(0, 32000) + '\n[结果已截断]' : text || '工具执行完成。';
  };
  return sessions && server.transport.type === 'stdio' && server.transport.keepAlive
    ? sessions.use(server, cwd, signal, work, beforeCall)
    : useClient(server, cwd, signal, work);
}
