import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { hash, type Emit } from './policy.js';

export function evidenceWriter(file: string, scope: string, secrets: string[] = []): Emit {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let seq = 0;
  return (type, data) => {
    let line = JSON.stringify({ scope, seq: ++seq, at: new Date().toISOString(), type, data });
    for (const secret of secrets.filter(value => value.length > 8)) {
      line = line.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
    }
    appendFileSync(file, line + '\n', { mode: 0o600 });
  };
}

export class EventObserver {
  readonly calls = new Map<string, string>();
  readonly toolResults = new Map<string, boolean>();
  readonly results: SDKResultMessage[] = [];
  readonly eventTypes = new Set<string>();
  readonly responseModels = new Set<string>();
  readonly textBlocks = new Map<string, string>();
  sessionId?: string;
  initTools: string[] = [];
  cliVersion?: string;
  textDeltas = 0;
  messageStops = 0;
  private readonly seen = new Set<string>();
  constructor(private readonly emit: Emit) {}

  observe(message: SDKMessage): void {
    const subtype = 'subtype' in message ? String(message.subtype) : undefined;
    this.eventTypes.add(message.type + (subtype ? ':' + subtype : ''));
    // Partial frames can share UUIDs; never deduplicate deltas by wrapper UUID.
    if (message.type === 'stream_event') {
      const event = message.event;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') this.textDeltas++;
      if (event.type === 'message_stop') this.messageStops++;
      this.emit('sdk.stream', { event: event.type, delta: 'delta' in event && 'type' in event.delta ? event.delta.type : undefined, index: 'index' in event ? event.index : undefined });
      return;
    }
    if (message.type === 'system' && message.subtype === 'init') {
      this.sessionId = message.session_id; this.initTools = message.tools; this.cliVersion = message.claude_code_version;
      this.emit('sdk.init', { sessionId: message.session_id, tools: message.tools, model: message.model, cliVersion: message.claude_code_version, mcpServers: message.mcp_servers.map(server => ({ name: server.name, status: server.status })) });
      return;
    }
    if (message.type === 'assistant') {
      this.responseModels.add(message.message.model);
      for (const block of message.message.content) {
        const key = message.message.id + ':' + hash(JSON.stringify(block));
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        if (block.type === 'text') {
          this.textBlocks.set(key, block.text);
          this.emit('sdk.text', { messageId: message.message.id, hash: hash(block.text), characters: block.text.length });
        }
        if (block.type === 'tool_use') {
          this.calls.set(block.id, block.name);
          this.emit('sdk.tool_use', { id: block.id, tool: block.name });
        }
      }
      return;
    }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) if (block.type === 'tool_result') {
        this.toolResults.set(block.tool_use_id, !block.is_error);
        this.emit('sdk.tool_result', { id: block.tool_use_id, isError: !!block.is_error, knownCall: this.calls.has(block.tool_use_id) });
      }
      return;
    }
    if (message.type === 'result') {
      if (this.seen.has(message.uuid)) return;
      this.seen.add(message.uuid); this.results.push(message); this.sessionId = message.session_id;
      this.emit('sdk.result', {
        sessionId: message.session_id, subtype: message.subtype, isError: message.is_error,
        stopReason: message.stop_reason, terminalReason: message.terminal_reason ?? null,
        turns: message.num_turns, durationMs: message.duration_ms,
        usage: message.usage ?? null, modelUsage: message.modelUsage ?? null,
        sdkEstimatedUsd: message.total_cost_usd ?? null, actualBillingUsd: null,
        pricingValidity: 'unknown-for-chatgpt-plan',
      });
      return;
    }
    // Preserve discoverability of new events without dumping arbitrary payloads.
    this.emit('sdk.other', { type: message.type, subtype });
  }
  successfulTool(name: string): boolean {
    return [...this.calls].some(([id, tool]) => tool === name && this.toolResults.get(id) === true);
  }
  finalText(): string {
    const last = this.results.at(-1);
    return last?.subtype === 'success' ? last.result : [...this.textBlocks.values()].join('\n');
  }
  summary() {
    return {
      sessionId: this.sessionId, cliVersion: this.cliVersion, initTools: this.initTools,
      responseModels: [...this.responseModels], eventTypes: [...this.eventTypes],
      textDeltas: this.textDeltas, messageStops: this.messageStops,
      calls: [...this.calls].map(([id, name]) => ({ id, name, succeeded: this.toolResults.get(id) ?? null })),
      results: this.results.map(result => ({ subtype: result.subtype, isError: result.is_error, stopReason: result.stop_reason, terminalReason: result.terminal_reason ?? null, turns: result.num_turns, sdkEstimatedUsd: result.total_cost_usd ?? null, usage: result.usage ?? null, modelUsage: result.modelUsage ?? null })),
      actualBillingUsd: null, pricingValidity: 'unknown-for-chatgpt-plan', structuredPlan: 'not-observed; plan tools intentionally disabled',
    };
  }
}

// Pattern adapted from the existing demo's MessageInput; no external project dependency.
export class MessageInput<T> {
  private readonly values: T[] = [];
  private closed = false;
  private wake?: () => void;
  push(value: T): void { if (this.closed) throw new Error('INPUT_CLOSED'); this.values.push(value); this.wake?.(); }
  end(): void { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.values.length) { yield this.values.shift()!; continue; }
      if (this.closed) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}
