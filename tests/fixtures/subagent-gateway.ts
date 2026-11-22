import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

export type FixtureTool = { name: string; id: string; input: Record<string, unknown> };

const defaultUsage = {
  input_tokens: 12,
  output_tokens: 8,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export function sendModelReply(
  res: ServerResponse,
  model: string,
  reply: string | FixtureTool[],
  usage = defaultUsage,
) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'request-id': randomUUID(),
  });
  const send = (type: string, values: object = {}) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...values })}\n\n`);
  send('message_start', {
    message: {
      id: `msg_${randomUUID()}`,
      role: 'assistant',
      type: 'message',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...usage, output_tokens: 0 },
    },
  });
  if (typeof reply === 'string') {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } });
    send('content_block_stop', { index: 0 });
  } else {
    reply.forEach(({ name, id, input }, index) => {
      send('content_block_start', {
        index,
        content_block: { type: 'tool_use', name, id, input: {} },
      });
      send('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      });
      send('content_block_stop', { index });
    });
  }
  send('message_delta', {
    delta: {
      stop_reason: typeof reply === 'string' ? 'end_turn' : 'tool_use',
      stop_sequence: null,
    },
    usage,
  });
  send('message_stop');
  res.end();
}
