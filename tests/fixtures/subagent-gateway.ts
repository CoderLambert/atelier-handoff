/**
 * @file 为原生 SDK 回归提供回环模型流式响应。
 * @implementation 将文本和工具调用构造成模型 SSE 事件及用量，供隔离回归复用。
 * @updated 2026-11-26T23:08:48+08:00
 */
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
  reply: string | Array<string | FixtureTool>,
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
  const blocks = typeof reply === 'string' ? [reply] : reply;
  blocks.forEach((block, index) => {
    if (typeof block === 'string') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block } });
    } else {
      const { name, id, input } = block;
      send('content_block_start', {
        index,
        content_block: { type: 'tool_use', name, id, input: {} },
      });
      send('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', {
    delta: {
      stop_reason: blocks.some((block) => typeof block !== 'string') ? 'tool_use' : 'end_turn',
      stop_sequence: null,
    },
    usage,
  });
  send('message_stop');
  res.end();
}
