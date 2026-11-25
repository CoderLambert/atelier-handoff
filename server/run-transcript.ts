/**
 * @file 记录一次运行的公开正文与工具调用顺序。
 * @implementation 按 SDK 响应和内容块关联增量及完整回执，生成可随正文一同持久化的片段区间。
 * @updated 2026-11-26T00:58:00+08:00
 */
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { TranscriptPart } from '../shared/ordered-transcript.js';
import { now, type Message } from '../shared/types.js';

type TextBlock = Pick<TranscriptPart, 'id' | 'order' | 'at'> & {
  text: string;
  confirmed: boolean;
};
type Response = {
  owner: string;
  explicitOwner: boolean;
  blocks: TextBlock[];
  streamedText: Map<number, TextBlock>;
};
type Reply = { blocks: TextBlock[]; dirty: boolean };
type InputOwner = { id: string; order: number };
type ToolPosition = { id: string; name: string; order: number; at: string };

export class RunTranscript {
  private ordinal = 0;
  private readonly tools = new Map<string, ToolPosition>();
  private readonly observedTools: ToolPosition[] = [];
  private readonly replies = new Map<string, Reply>();
  private readonly owners = new Map<string, InputOwner>();
  private readonly responses = new Map<string, Response>();
  private readonly confirmed = new Map<string, string>();
  private sdkOwner?: InputOwner;
  private stream?: Response;

  nextOrder(): number {
    return ++this.ordinal;
  }

  toolPosition(id: string): ToolPosition | undefined {
    return this.tools.get(id);
  }

  takeObservedTools(): ToolPosition[] {
    return this.observedTools.splice(0);
  }

  associateInput(id: string | undefined, owner: string): void {
    const input = { id: owner, order: this.ordinal };
    if (id) this.owners.set(id, input);
    this.sdkOwner ??= input;
  }

  private observeTool(id: string, name: string): void {
    if (this.tools.has(id)) return;
    const position = { id, name, order: this.nextOrder(), at: now() };
    this.tools.set(id, position);
    this.observedTools.push(position);
  }

  acceptStream(
    frame: SDKPartialAssistantMessage,
    currentOwner: string,
    toolId: (sdkId: string) => string,
  ): void {
    const { event, user_message_uuid: inputId } = frame;
    if (event.type === 'message_start') {
      this.stream = this.response(event.message.id, currentOwner, inputId);
      return;
    }
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      this.observeTool(toolId(event.content_block.id), event.content_block.name);
      return;
    }
    const response = this.stream;
    if (!response) return;
    this.bindResponse(response, this.inputOwner(inputId));
    if (event.type === 'content_block_start' && event.content_block.type === 'text') {
      this.streamedBlock(response, event.index, event.content_block.text);
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const block = this.streamedBlock(response, event.index, '');
      if (!block.confirmed && event.delta.text) {
        block.text += event.delta.text;
        this.reply(response.owner).dirty = true;
      }
    }
  }

  acceptAssistant(
    frame: SDKAssistantMessage,
    currentOwner: string,
    toolId: (sdkId: string) => string,
  ): string {
    const oldOwner = this.confirmed.get(frame.uuid);
    if (oldOwner) return oldOwner;
    const response = this.response(frame.message.id, currentOwner, frame.user_message_uuid);
    this.confirmed.set(frame.uuid, response.owner);
    if (frame.error) return response.owner;
    const { content } = frame.message;
    for (const [index, block] of content.entries()) {
      if (block.type === 'tool_use') {
        this.observeTool(toolId(block.id), block.name);
        continue;
      }
      if (block.type !== 'text' || !block.text) continue;
      // Native SDK emits a receipt per public block, and full content arrays are
      // also possible. The receipt replaces accumulated text instead of appending.
      const pending = [...response.streamedText.values()].filter((part) => !part.confirmed);
      const streamed =
        content.length > 1
          ? response.streamedText.get(index)
          : (pending.find((part) => part.text === block.text) ?? pending[0]);
      const part = streamed ?? this.responseBlock(response, '');
      if (part.text !== block.text) {
        part.text = block.text;
        this.reply(response.owner).dirty = true;
      }
      part.confirmed = true;
    }
    return response.owner;
  }

  fallback(owner: string, text: string): void {
    if (text && !this.replies.get(owner)?.blocks.some((block) => block.text))
      this.addBlock(owner, text);
  }

  takeChanges(): Array<{ id: string } & Pick<Message, 'text' | 'transcriptParts'>> {
    const changes: Array<{ id: string; text: string; transcriptParts: TranscriptPart[] }> = [];
    for (const [id, reply] of this.replies) {
      if (!reply.dirty) continue;
      const transcriptParts: TranscriptPart[] = [];
      const chunks: string[] = [];
      let offset = 0;
      for (const block of reply.blocks) {
        if (!block.text) continue;
        if (chunks.length) offset += 2;
        const end = offset + block.text.length;
        transcriptParts.push({
          id: block.id,
          order: block.order,
          at: block.at,
          start: offset,
          end,
        });
        chunks.push(block.text);
        offset = end;
      }
      changes.push({ id, text: chunks.join('\n\n'), transcriptParts });
      reply.dirty = false;
    }
    return changes;
  }

  private inputOwner(inputId?: string): InputOwner | undefined {
    const input = inputId ? this.owners.get(inputId) : undefined;
    if (input && (!this.sdkOwner || this.sdkOwner.order <= input.order)) this.sdkOwner = input;
    return input;
  }

  private response(id: string, currentOwner: string, inputId?: string): Response {
    const input = this.inputOwner(inputId);
    let response = this.responses.get(id);
    if (!response) {
      response = {
        owner: input?.id ?? this.sdkOwner?.id ?? currentOwner,
        explicitOwner: !!input,
        blocks: [],
        streamedText: new Map(),
      };
      this.responses.set(id, response);
    } else {
      this.bindResponse(response, input);
    }
    return response;
  }

  private bindResponse(response: Response, input: InputOwner | undefined): void {
    if (!input || response.explicitOwner) return;
    response.explicitOwner = true;
    if (response.owner === input.id) return;
    const previous = this.reply(response.owner);
    const moved = new Set(response.blocks);
    previous.blocks = previous.blocks.filter((block) => !moved.has(block));
    previous.dirty = true;
    const current = this.reply(input.id);
    current.blocks.push(...response.blocks);
    current.blocks.sort((a, b) => a.order - b.order);
    current.dirty = true;
    response.owner = input.id;
  }

  private reply(id: string): Reply {
    let reply = this.replies.get(id);
    if (!reply) {
      reply = { blocks: [], dirty: false };
      this.replies.set(id, reply);
    }
    return reply;
  }

  private addBlock(owner: string, text: string): TextBlock {
    const order = this.nextOrder();
    const block = { id: owner + ':' + order, order, at: now(), text, confirmed: false };
    const reply = this.reply(owner);
    reply.blocks.push(block);
    if (text) reply.dirty = true;
    return block;
  }

  private responseBlock(response: Response, text: string): TextBlock {
    const block = this.addBlock(response.owner, text);
    response.blocks.push(block);
    return block;
  }

  private streamedBlock(response: Response, index: number, text: string): TextBlock {
    let block = response.streamedText.get(index);
    if (!block) {
      block = this.responseBlock(response, text);
      response.streamedText.set(index, block);
    }
    return block;
  }
}
