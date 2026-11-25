/**
 * @file 核对 SDK 顺序记录在延迟回执和插话中的分段归属。
 * @implementation 以 SDK 类型化帧重放旧回复迟到、新用户投递及并行工具调用。
 * @updated 2026-11-26T01:13:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { RunTranscript } from '../server/run-transcript.js';

const sdkSessionId = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const localToolId = (id: string) => 'run:' + id;

function modelMessage(id: string): SDKAssistantMessage['message'] {
  return {
    id,
    role: 'assistant',
    type: 'message',
    model: 'fixture-model',
    content: [],
    container: null,
    context_management: null,
    diagnostics: null,
    stop_details: null,
    stop_reason: null,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: 0,
      iterations: null,
      output_tokens: 0,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

function send(
  transcript: RunTranscript,
  event: SDKPartialAssistantMessage['event'],
  owner: string,
  inputId?: string,
): void {
  transcript.acceptStream(
    {
      type: 'stream_event',
      uuid: randomUUID(),
      session_id: sdkSessionId,
      parent_tool_use_id: null,
      event,
      user_message_uuid: inputId,
    },
    owner,
    localToolId,
  );
}

function complete(
  transcript: RunTranscript,
  nativeId: string,
  text: string,
  owner: string,
  inputId?: string,
): void {
  transcript.acceptAssistant(
    {
      type: 'assistant',
      uuid: randomUUID(),
      parent_tool_use_id: null,
      session_id: sdkSessionId,
      user_message_uuid: inputId,
      message: {
        ...modelMessage(nativeId),
        content: [{ type: 'text', text, citations: null }],
      },
    },
    owner,
    localToolId,
  );
}

test('tool positions come from SDK frames even if a hook has already looked up its call', () => {
  const transcript = new RunTranscript();
  transcript.associateInput(userA, 'reply-a');
  assert.equal(transcript.toolPosition('run:second'), undefined);
  send(transcript, { type: 'message_start', message: modelMessage('native-a') }, 'reply-a', userA);
  send(
    transcript,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'first', citations: null },
    },
    'reply-a',
  );
  for (const [index, id] of ['first', 'second'].entries())
    send(
      transcript,
      {
        type: 'content_block_start',
        index: index + 1,
        content_block: { type: 'tool_use', id, name: 'Read', input: {} },
      },
      'reply-a',
    );
  assert.deepEqual(
    transcript.takeObservedTools().map(({ id, order }) => [id, order]),
    [
      ['run:first', 2],
      ['run:second', 3],
    ],
  );
  assert.equal(transcript.takeChanges()[0]?.transcriptParts?.[0]?.order, 1);
});

test('unstamped replies belong to the last SDK-confirmed user until the insertion is acknowledged', () => {
  const transcript = new RunTranscript();
  transcript.associateInput(userA, 'reply-a');
  complete(transcript, 'native-a-1', 'opening A', 'reply-a', userA);
  transcript.nextOrder();
  transcript.associateInput(userB, 'reply-b');
  complete(transcript, 'native-a-2', 'late A', 'reply-b');
  complete(transcript, 'native-b-1', 'opening B', 'reply-b', userB);
  complete(transcript, 'native-b-2', 'later B', 'reply-b');
  assert.deepEqual(
    transcript.takeChanges().map(({ id, text }) => [id, text]),
    [
      ['reply-a', 'opening A\n\nlate A'],
      ['reply-b', 'opening B\n\nlater B'],
    ],
  );
});
