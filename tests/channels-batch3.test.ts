/**
 * @file 验证 Batch 3：HarnessBridge 串行队列、1200ms 节流编辑、3800 字符分片、/stop 中止，以及 ChannelManager.broadcastToBound 定时任务推送。
 * @updated 2026-11-28T11:50:00+08:00
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  ChannelBinding,
  ChannelId,
  ChannelSessionMapping,
  ChannelStatus,
  ChannelTestResult,
} from '../shared/channels.js';
import type { RunEvent } from '../shared/types.js';
import { ChannelManager } from '../desktop/channels/channel-manager.mjs';
import { ChannelConfigStore } from '../desktop/channels/config-store.mjs';
import {
  HarnessBridge,
  THINKING_PLACEHOLDER,
  type HarnessBridgeClient,
} from '../desktop/channels/harness-bridge.mjs';
import { PairingGuard, type PairingBindingStore } from '../desktop/channels/pairing-guard.mjs';
import { ChannelSecretStore, type SafeStorageLike } from '../desktop/channels/secret-store.mjs';
import type {
  ChannelAdapter,
  ChannelStatusListener,
  InboundMessage,
  InboundMessageHandler,
} from '../desktop/channels/types.mjs';

class MockTelegramAdapter implements ChannelAdapter {
  readonly id: ChannelId = 'telegram';
  private status: ChannelStatus = {
    channel: 'telegram',
    state: 'connected',
    botUsername: '@atelier_test_bot',
    error: null,
    updatedAt: new Date().toISOString(),
  };
  private messageHandlers = new Set<InboundMessageHandler>();
  private statusListeners = new Set<ChannelStatusListener>();
  readonly sent: { chatId: string; messageId: string; text: string }[] = [];
  readonly edits: { chatId: string; messageId: string; text: string }[] = [];

  async start(): Promise<void> {
    this.status = { ...this.status, state: 'connected' };
  }
  async stop(): Promise<void> {
    this.status = { ...this.status, state: 'disconnected' };
  }
  async testConnection(): Promise<ChannelTestResult> {
    return { ok: true, botUsername: '@atelier_test_bot', error: null };
  }
  async send(chatId: string, text: string) {
    const messageId = `m-${this.sent.length + 1}`;
    this.sent.push({ chatId, messageId, text });
    return { messageId };
  }
  async edit(chatId: string, messageId: string, text: string) {
    this.edits.push({ chatId, messageId, text });
  }
  onMessage(handler: InboundMessageHandler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }
  onStatusChange(listener: ChannelStatusListener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  getStatus(): ChannelStatus {
    return this.status;
  }
}

const sampleMapping: ChannelSessionMapping = {
  channel: 'telegram',
  chatId: '100',
  atelierSessionId: 'sess-100',
  workspacePath: '/repo/demo',
  projectId: 'proj-1',
  updatedAt: new Date().toISOString(),
};

function makeInbound(text: string, chatId = '100'): InboundMessage {
  return {
    channel: 'telegram',
    chatId,
    senderId: chatId,
    senderName: 'Tester',
    senderUsername: 'tester',
    text,
    messageId: '1',
    receivedAt: new Date().toISOString(),
  };
}

test('HarnessBridge sends placeholder, throttles edits, auto-chunks >3800 chars, and flushes final output', async () => {
  const listeners = new Set<(event: RunEvent) => void>();
  let assistantText = '';
  let seq = 0;

  const emit = (runId: string, type: string, payload: Record<string, unknown> = {}) => {
    seq += 1;
    const ev: RunEvent = {
      id: seq,
      runId,
      sessionId: 'sess-100',
      seq,
      type,
      at: new Date().toISOString(),
      payload,
    };
    for (const l of listeners) l(ev);
  };

  const client: HarnessBridgeClient = {
    async startSessionMessage() {
      return { runId: 'run-1' };
    },
    async stopRun() {},
    async getAssistantText() {
      return assistantText;
    },
    subscribeEvents(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
  };

  // Use 40ms throttle in unit test for fast deterministic verification
  const bridge = new HarnessBridge(client, 40, 3800);
  const adapter = new MockTelegramAdapter();

  const turnPromise = bridge.enqueue(makeInbound('写一份长报告'), sampleMapping, adapter);
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0]?.text, THINKING_PLACEHOLDER);

  // Rapid bursts should coalesce into throttled edits
  assistantText = '第一段内容...';
  emit('run-1', 'message.delta');
  assistantText = '第一段内容...第二段内容...';
  emit('run-1', 'message.delta');
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(adapter.edits.length, 1);
  assert.equal(adapter.edits[0]?.text, '第一段内容...第二段内容...');

  // Final output exceeds 3800 chars -> edits first message and sends second chunk
  assistantText = `${'A'.repeat(3000)}\n${'B'.repeat(1500)}`;
  emit('run-1', 'run.finished', { status: 'completed' });
  await turnPromise;

  assert.equal(adapter.sent.length, 2);
  assert.ok(adapter.edits.at(-1)!.text.length <= 3800);
  assert.ok(adapter.sent[1]!.text.includes('B'));
});

test('HarnessBridge enforces per-chatId serial queue and supports /stop abort', async () => {
  const listeners = new Set<(event: RunEvent) => void>();
  const startedOrder: string[] = [];
  const stoppedRuns: string[] = [];
  let seq = 0;

  const emit = (runId: string, type: string, payload: Record<string, unknown> = {}) => {
    seq += 1;
    for (const l of listeners) {
      l({
        id: seq,
        runId,
        sessionId: 'sess-100',
        seq,
        type,
        at: new Date().toISOString(),
        payload,
      });
    }
  };

  const client: HarnessBridgeClient = {
    async startSessionMessage(_sessionId, text) {
      const runId = `run-${startedOrder.length + 1}`;
      startedOrder.push(`${runId}:${text}`);
      return { runId };
    },
    async stopRun(runId) {
      stoppedRuns.push(runId);
      emit(runId, 'run.finished', { status: 'canceled' });
    },
    async getAssistantText(_sessionId, runId) {
      return runId === 'run-2' ? '第二条已完成' : '';
    },
    subscribeEvents(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
  };

  const bridge = new HarnessBridge(client, 30, 3800);
  const adapter = new MockTelegramAdapter();

  const p1 = bridge.enqueue(makeInbound('任务一'), sampleMapping, adapter);
  const p2 = bridge.enqueue(makeInbound('任务二'), sampleMapping, adapter);

  await new Promise((r) => setTimeout(r, 15));
  // Only task 1 should have started; task 2 waits in the serial queue
  assert.deepEqual(startedOrder, ['run-1:任务一']);
  assert.equal(bridge.isRunActive('telegram', '100'), true);

  // /stop aborts task 1 immediately
  const stopped = await bridge.stopActiveRun('telegram', '100');
  assert.equal(stopped, true);
  assert.deepEqual(stoppedRuns, ['run-1']);
  await p1;

  // Now task 2 starts
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(startedOrder, ['run-1:任务一', 'run-2:任务二']);
  emit('run-2', 'run.finished', { status: 'completed' });
  await p2;

  assert.equal(bridge.isRunActive('telegram', '100'), false);
  assert.equal(adapter.edits.at(-1)?.text, '第二条已完成');
});

test('ChannelManager.broadcastToBound delivers scheduled task results only when enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-ch-b3-'));
  try {
    const bindings: ChannelBinding[] = [
      {
        id: 'b1',
        channel: 'telegram',
        chatId: '101',
        label: 'Alice',
        username: 'alice',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'b2',
        channel: 'telegram',
        chatId: '202',
        label: 'Bob',
        username: 'bob',
        createdAt: new Date().toISOString(),
      },
    ];
    const bindingStore: PairingBindingStore = {
      async listBindings() {
        return bindings;
      },
      async upsertBinding(input) {
        return { ...input, createdAt: new Date().toISOString() };
      },
      async deleteBinding() {
        return true;
      },
    };
    const fakeSafeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
    };

    const guard = new PairingGuard(bindingStore);
    const manager = new ChannelManager(
      new ChannelSecretStore(dir, fakeSafeStorage),
      new ChannelConfigStore(dir),
      { pairingGuard: guard },
    );
    const adapter = new MockTelegramAdapter();
    manager.registerAdapter(adapter);
    await manager.saveConfig({
      channel: 'telegram',
      token: '123456:SECRET_TOKEN',
      enabled: true,
      pushScheduleResults: false,
    });

    // Scheduled push switch is OFF -> skipped
    const skipped = await manager.broadcastScheduleResult('telegram', '⏰ 每日同步完成');
    assert.equal(skipped.delivered, 0);
    assert.equal(adapter.sent.length, 0);

    // Direct broadcastToBound works for all bound chats
    const direct = await manager.broadcastToBound('telegram', '直接广播消息');
    assert.equal(direct.delivered, 2);
    assert.equal(adapter.sent.length, 2);

    // Enable pushScheduleResults -> scheduled result delivered to both bound chats
    await manager.saveConfig({ channel: 'telegram', pushScheduleResults: true });
    const pushed = await manager.broadcastScheduleResult('telegram', '⏰ 每日同步完成');
    assert.equal(pushed.delivered, 2);
    assert.equal(adapter.sent.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
