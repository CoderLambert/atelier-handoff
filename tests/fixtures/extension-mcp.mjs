import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

function fixture() {
  const server = new McpServer({ name: 'atelier-fixture', version: '1.0.0' });
  server.registerTool(
    'fixture_echo',
    {
      description: 'Return a test marker for the supplied text.',
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: 'text', text: `fixture-result:${text}` }] }),
  );
  let calls = 0;
  server.registerTool(
    'fixture_count',
    { description: 'Count calls on this process.' },
    async () => ({
      content: [{ type: 'text', text: String(++calls) }],
    }),
  );
  return server;
}

if (process.argv[2] === '--http') {
  createServer(async (request, response) => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    const server = fixture();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.once('close', () => void server.close());
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  }).listen(Number(process.argv[3]), '127.0.0.1');
} else await fixture().connect(new StdioServerTransport());
