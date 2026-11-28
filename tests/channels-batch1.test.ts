/**
 * @file 验证 Batch 1 通道骨架：SQLite v16 迁移、Token 加密存储、消息分片与 ChannelManager Echo 生命周期。
 * @implementation 使用隔离临时目录和内存模拟 safeStorage/Adapter，不依赖真实 Telegram 网络。
 * @updated 2026-11-28T10:40:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  maskBotToken,
  splitTelegramMessage,
  type ChannelStatus,
  type ChannelTestResult,
} from '../shared/channels.js';
import { Store } from '../server/store.js';
import { ChannelSecretStore, type SafeStorageLike } from '../desktop/channels/secret-store.mjs';
import { ChannelConfigStore } from '../desktop/channels/config-store.mjs';
import { ChannelManager } from '../desktop/channels/channel-manager.mjs';
import type {
  ChannelAdapter,
  ChannelStatusListener,
  InboundMessage,
  InboundMessageHandler,
  OutboundMessageRef,
} from '../desktop/channels/types.mjs';

function createMockSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) =>
      Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('hex')}`, 'utf8'),
    decryptString: (buf) => {
      const raw = buf.toString('utf8');
      assert.ok(raw.startsWith('enc:'));
      return Buffer.from(raw.slice(4), 'hex').toString('utf8');
    },
  };
}

class MockTelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram' as const;
  startedWith: string | null = null;
  stoppedCount = 0;
  sent: { chatId: string; text: string }[] = [];
  private readonly handlers = new Set<InboundMessageHandler>();
  private readonly listeners = new Set<ChannelStatusListener>();
  private status: ChannelStatus = {
    channel: 'telegram',
    state: 'disconnected',
    botUsername: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };

  async start(token: string): Promise<void> {
    this.startedWith = token;
    this.updateStatus('connected', '@atelier_test_bot', null);
  }

  async stop(): Promise<void> {
    this.stoppedCount += 1;
    this.updateStatus('disconnected', this.status.botUsername, null);
  }

  async testConnection(token: string): Promise<ChannelTestResult> {
    if (token === 'valid-token-123456:AAabcdef1234') {
      return { ok: true, botUsername: '@atelier_test_bot', error: null };
    }
    return { ok: false, botUsername: null, error: 'Unauthorized' };
  }

  async send(chatId: string, text: string): Promise<OutboundMessageRef> {
    this.sent.push({ chatId, text });
    return { messageId: String(this.sent.length) };
  }

  async edit(): Promise<void> {}

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  onMessage(handler: InboundMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatusChange(listener: ChannelStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emitInbound(message: InboundMessage): Promise<void> {
    for (const handler of this.handlers) await handler(message);
  }

  private updateStatus(
    state: ChannelStatus['state'],
    botUsername: string | null,
    error: string | null,
  ) {
    this.status = {
      channel: 'telegram',
      state,
      botUsername,
      error,
      updatedAt: new Date().toISOString(),
    };
    for (const listener of this.listeners) listener(this.getStatus());
  }
}

test('maskBotToken hides secret middle portion while preserving recognizable edges', () => {
  assert.equal(maskBotToken(''), '');
  const masked = maskBotToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  assert.ok(masked.startsWith('123456789:AA'));
  assert.ok(masked.endsWith('Dsaw'));
  assert.ok(!masked.includes('HdqTcvCH1vGWJxfSeofSAs0K5PAL'));
});

test('splitTelegramMessage splits long text cleanly within maxLength', () => {
  const short = 'hello telegram';
  assert.deepEqual(splitTelegramMessage(short, 4096), [short]);

  const lines = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}: ${'x'.repeat(50)}`).join(
    '\n',
  );
  const chunks = splitTelegramMessage(lines, 1000);
  assert.ok(chunks.length > 5);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1000, `chunk exceeded limit: ${chunk.length}`);
  }
  assert.equal(chunks.join(''), lines);
});

test('SQLite v16 migration creates channel_bindings and channel_sessions with CRUD support', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-channels-db-'));
  const store = new Store(dir);
  try {
    const binding = store.repos.channels.upsertBinding({
      id: randomUUID(),
      channel: 'telegram',
      chatId: '998877',
      label: 'Alice',
      username: '@alice',
      createdAt: new Date().toISOString(),
    });
    assert.equal(binding.chatId, '998877');
    assert.equal(store.repos.channels.listBindings('telegram').length, 1);
    assert.equal(store.repos.channels.findBinding('telegram', '998877')?.username, '@alice');

    store.repos.channels.upsertSession({
      channel: 'telegram',
      chatId: '998877',
      atelierSessionId: 'session-1',
      projectId: 'project-1',
      workspacePath: '/tmp/work',
      updatedAt: new Date().toISOString(),
    });
    assert.equal(
      store.repos.channels.getSession('telegram', '998877')?.atelierSessionId,
      'session-1',
    );

    assert.equal(store.repos.channels.deleteSession('telegram', '998877'), true);
    assert.equal(store.repos.channels.getSession('telegram', '998877'), undefined);
    assert.equal(store.repos.channels.deleteBinding('telegram', '998877'), true);
    assert.equal(store.repos.channels.listBindings('telegram').length, 0);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('ChannelSecretStore encrypts tokens via safeStorage and never writes plaintext to disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-channels-secret-'));
  try {
    const token = '987654321:AAsecret_token_never_plaintext';
    const store = new ChannelSecretStore(dir, createMockSafeStorage(true));
    await store.setToken('telegram', token);

    const diskContent = await readFile(join(dir, 'channel-secrets.json'), 'utf8');
    assert.ok(!diskContent.includes(token), 'Plaintext token must never appear on disk');
    assert.equal(await store.getToken('telegram'), token);

    await store.deleteToken('telegram');
    assert.equal(await store.getToken('telegram'), null);

    const unavailable = new ChannelSecretStore(dir, createMockSafeStorage(false));
    await assert.rejects(() => unavailable.setToken('telegram', token));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ChannelManager manages lifecycle, echoes messages in Batch 1, and restores state on restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-channels-mgr-'));
  const safe = createMockSafeStorage(true);
  try {
    const secrets = new ChannelSecretStore(dir, safe);
    const configs = new ChannelConfigStore(dir);
    const adapter = new MockTelegramAdapter();
    const manager = new ChannelManager(secrets, configs);
    manager.registerAdapter(adapter);

    const token = 'valid-token-123456:AAabcdef1234';
    const testResult = await manager.testConnection('telegram', token);
    assert.equal(testResult.ok, true);
    assert.equal(testResult.botUsername, '@atelier_test_bot');

    const saved = await manager.saveConfig({ channel: 'telegram', token });
    assert.equal(saved.config.hasToken, true);
    assert.ok(!saved.config.maskedToken.includes('AAabcdef'));

    const enabled = await manager.toggleChannel('telegram', true);
    assert.equal(enabled.config.enabled, true);
    assert.equal(enabled.status.state, 'connected');

    await adapter.emitInbound({
      channel: 'telegram',
      chatId: '42',
      messageId: '101',
      senderId: '42',
      senderName: 'Tester',
      senderUsername: '@tester',
      text: 'ping',
      receivedAt: new Date().toISOString(),
    });
    assert.deepEqual(adapter.sent, [{ chatId: '42', text: 'Echo: ping' }]);

    await manager.stopAll();
    assert.equal(adapter.stoppedCount, 1);

    // Simulate app restart with fresh stores and adapter
    const adapter2 = new MockTelegramAdapter();
    const manager2 = new ChannelManager(
      new ChannelSecretStore(dir, safe),
      new ChannelConfigStore(dir),
    );
    manager2.registerAdapter(adapter2);
    await manager2.restoreEnabledChannels();
    assert.equal(adapter2.startedWith, token);
    assert.equal(manager2.getStatus('telegram').state, 'connected');
    await manager2.stopAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
