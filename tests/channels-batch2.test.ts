/**
 * @file 验证 Batch 2：PairingGuard 配对鉴权与解绑、SessionRouter 会话映射与指令拦截、以及 ChannelManager 串联流程。
 * @updated 2026-11-28T11:25:00+08:00
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
  PendingPairing,
} from '../shared/channels.js';
import { ChannelManager } from '../desktop/channels/channel-manager.mjs';
import { ChannelConfigStore } from '../desktop/channels/config-store.mjs';
import {
  PAIRING_CODE_TTL_MS,
  PairingGuard,
  type PairingBindingStore,
} from '../desktop/channels/pairing-guard.mjs';
import { ChannelSecretStore, type SafeStorageLike } from '../desktop/channels/secret-store.mjs';
import {
  parseSlashCommand,
  SessionRouter,
  type SessionRouterStore,
} from '../desktop/channels/session-router.mjs';
import type {
  ChannelAdapter,
  ChannelStatusListener,
  InboundMessage,
  InboundMessageHandler,
} from '../desktop/channels/types.mjs';
import { Store } from '../server/store.js';

function createMemoryBindingStore(): PairingBindingStore {
  const map = new Map<string, ChannelBinding>();
  return {
    async listBindings(channel) {
      const all = Array.from(map.values());
      return channel ? all.filter((b) => b.channel === channel) : all;
    },
    async upsertBinding(input) {
      const binding: ChannelBinding = {
        ...input,
        createdAt: new Date().toISOString(),
      };
      map.set(`${input.channel}:${input.chatId}`, binding);
      return binding;
    },
    async deleteBinding(channel, chatId) {
      return map.delete(`${channel}:${chatId}`);
    },
  };
}

function createMemorySessionStore(): SessionRouterStore & { createdCount: number } {
  const sessions = new Map<string, ChannelSessionMapping>();
  const store = {
    createdCount: 0,
    async getChannelSession(channel: ChannelId, chatId: string) {
      return sessions.get(`${channel}:${chatId}`) ?? null;
    },
    async upsertChannelSession(input: {
      channel: ChannelId;
      chatId: string;
      atelierSessionId: string;
      workspacePath: string;
      projectId: string;
    }) {
      const mapping: ChannelSessionMapping = {
        ...input,
        updatedAt: new Date().toISOString(),
      };
      sessions.set(`${input.channel}:${input.chatId}`, mapping);
      return mapping;
    },
    async deleteChannelSession(channel: ChannelId, chatId: string) {
      return sessions.delete(`${channel}:${chatId}`);
    },
    async getDefaultWorkspace() {
      return { projectId: 'proj-default', workspacePath: '/workspace/demo' };
    },
    async createAtelierSession(projectId: string, _title: string) {
      store.createdCount += 1;
      return { id: `sess-${store.createdCount}-abcdef`, projectId };
    },
  };
  return store;
}

class FakeAdapter implements ChannelAdapter {
  readonly id: ChannelId = 'telegram';
  private status: ChannelStatus = {
    channel: 'telegram',
    state: 'disconnected',
    botUsername: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };
  private messageHandlers = new Set<InboundMessageHandler>();
  private statusListeners = new Set<ChannelStatusListener>();
  readonly sent: { chatId: string; text: string }[] = [];

  async start(): Promise<void> {
    this.status = {
      channel: 'telegram',
      state: 'connected',
      botUsername: '@atelier_test_bot',
      error: null,
      updatedAt: new Date().toISOString(),
    };
    for (const l of this.statusListeners) l(this.status);
  }
  async stop(): Promise<void> {
    this.status = { ...this.status, state: 'disconnected' };
  }
  async testConnection(): Promise<ChannelTestResult> {
    return { ok: true, botUsername: '@atelier_test_bot', error: null };
  }
  async send(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return { messageId: String(this.sent.length) };
  }
  async edit(): Promise<void> {}
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
  async simulateInbound(msg: InboundMessage) {
    for (const h of this.messageHandlers) await h(msg);
  }
}

test('PairingGuard blocks unbound accounts, generates 6-digit code with 10m TTL, approves, and unbinds', async () => {
  let now = 1_700_000_000_000;
  const store = createMemoryBindingStore();
  const guard = new PairingGuard(store, () => now);
  const pushed: PendingPairing[] = [];
  guard.onPairingRequested((p) => pushed.push(p));

  const msg: InboundMessage = {
    channel: 'telegram',
    chatId: '9001',
    senderId: '9001',
    senderName: 'Alice',
    senderUsername: 'alice_tg',
    text: 'hello',
    messageId: '1',
    receivedAt: new Date(now).toISOString(),
  };

  // Unbound account is blocked and receives 6-digit code
  const first = await guard.checkAccess(msg);
  assert.equal(first.allowed, false);
  assert.match(first.pending.code, /^\d{6}$/);
  assert.equal(pushed.length, 1);
  assert.ok(first.replyText.includes(first.pending.code));

  // Same account before expiry reuses same code
  now += 2 * 60 * 1000;
  const second = await guard.checkAccess(msg);
  assert.equal(second.allowed, false);
  assert.equal(second.pending.code, first.pending.code);

  // After 10 min TTL, pending expires and approval fails
  now += PAIRING_CODE_TTL_MS + 1000;
  assert.equal(guard.listPending('telegram').length, 0);
  await assert.rejects(() => guard.approve('telegram', '9001'));

  // Fresh message generates a new code, then desktop approves
  const third = await guard.checkAccess(msg);
  assert.equal(third.allowed, false);
  const binding = await guard.approve('telegram', '9001');
  assert.equal(binding.chatId, '9001');
  assert.equal(guard.listPending('telegram').length, 0);

  // Now access is allowed
  const allowed = await guard.checkAccess(msg);
  assert.equal(allowed.allowed, true);

  // Unbind immediately revokes access
  const removed = await guard.unbind('telegram', '9001');
  assert.equal(removed, true);
  const afterUnbind = await guard.checkAccess(msg);
  assert.equal(afterUnbind.allowed, false);
});

test('SessionRouter intercepts /new, /stop, /status without forwarding to LLM and persists mapping', async () => {
  assert.equal(parseSlashCommand('/new'), '/new');
  assert.equal(parseSlashCommand('/STATUS@atelier_bot'), '/status');
  assert.equal(parseSlashCommand('/stop now'), '/stop');
  assert.equal(parseSlashCommand('hello world'), null);

  const store = createMemorySessionStore();
  const router = new SessionRouter(store);
  let stopCalled = 0;
  let running = false;
  router.setRunHooks({
    async stopActiveRun() {
      stopCalled += 1;
      const wasRunning = running;
      running = false;
      return wasRunning;
    },
    isRunActive() {
      return running;
    },
  });

  const makeMsg = (text: string): InboundMessage => ({
    channel: 'telegram',
    chatId: '42',
    senderId: '42',
    senderName: 'Bob',
    senderUsername: null,
    text,
    messageId: '1',
    receivedAt: new Date().toISOString(),
  });

  // /status before any session
  const st0 = await router.routeMessage(makeMsg('/status'));
  assert.equal(st0.kind, 'command');
  assert.ok(st0.replyText.includes('空闲'));
  assert.equal(store.createdCount, 0);

  // Normal message lazily creates a session and forwards
  const fwd1 = await router.routeMessage(makeMsg('帮我检查仓库状态'));
  assert.equal(fwd1.kind, 'forward');
  assert.equal(fwd1.mapping.atelierSessionId, 'sess-1-abcdef');
  assert.equal(fwd1.mapping.workspacePath, '/workspace/demo');

  // Second normal message reuses same session
  const fwd2 = await router.routeMessage(makeMsg('再看一下 git log'));
  assert.equal(fwd2.kind, 'forward');
  assert.equal(fwd2.mapping.atelierSessionId, 'sess-1-abcdef');
  assert.equal(store.createdCount, 1);

  // /stop when running aborts without creating session or entering LLM
  running = true;
  const stopRes = await router.routeMessage(makeMsg('/stop'));
  assert.equal(stopRes.kind, 'command');
  assert.equal(stopCalled, 1);
  assert.ok(stopRes.replyText.includes('中止'));

  // /new creates a fresh session in the same workspace
  const newRes = await router.routeMessage(makeMsg('/new'));
  assert.equal(newRes.kind, 'command');
  assert.equal(store.createdCount, 2);
  assert.ok(newRes.replyText.includes('sess-2-a'));
});

test('ChannelManager end-to-end with SQLite Store, PairingGuard, and SessionRouter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-ch-b2-'));
  const sqliteStore = new Store(dir);
  try {
    const fakeSafeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
    };
    const bindingStore: PairingBindingStore = {
      async listBindings(channel) {
        return sqliteStore.channels.listBindings(channel);
      },
      async upsertBinding(input) {
        return sqliteStore.channels.upsertBinding({
          ...input,
          createdAt: new Date().toISOString(),
        });
      },
      async deleteBinding(channel, chatId) {
        const ok = sqliteStore.channels.deleteBinding(channel, chatId);
        sqliteStore.channels.deleteSession(channel, chatId);
        return ok;
      },
    };
    const sessionStore: SessionRouterStore = {
      async getChannelSession(channel, chatId) {
        return sqliteStore.channels.getSession(channel, chatId) ?? null;
      },
      async upsertChannelSession(input) {
        return sqliteStore.channels.upsertSession({
          ...input,
          updatedAt: new Date().toISOString(),
        });
      },
      async deleteChannelSession(channel, chatId) {
        return sqliteStore.channels.deleteSession(channel, chatId);
      },
      async getDefaultWorkspace() {
        return { projectId: 'p1', workspacePath: '/repo/demo' };
      },
      async createAtelierSession(projectId) {
        return { id: 'sess-sqlite-001', projectId };
      },
    };

    const guard = new PairingGuard(bindingStore);
    const router = new SessionRouter(sessionStore);
    const manager = new ChannelManager(
      new ChannelSecretStore(dir, fakeSafeStorage),
      new ChannelConfigStore(dir),
      { pairingGuard: guard, sessionRouter: router },
    );
    const adapter = new FakeAdapter();
    manager.registerAdapter(adapter);
    await manager.saveConfig({ channel: 'telegram', token: '123456:SECRET_TOKEN', enabled: true });

    const baseMsg: InboundMessage = {
      channel: 'telegram',
      chatId: '777',
      senderId: '777',
      senderName: 'Charlie',
      senderUsername: 'charlie',
      text: '/status',
      messageId: '1',
      receivedAt: new Date().toISOString(),
    };

    // Unbound user gets pairing code even on /status
    await adapter.simulateInbound(baseMsg);
    assert.ok(adapter.sent.at(-1)?.text.includes('配对码'));

    // Approve in desktop
    const approvedSnap = await manager.approvePairing('telegram', '777');
    assert.equal(approvedSnap.bindings.length, 1);
    assert.equal(approvedSnap.pendingPairings.length, 0);

    // Bound user now gets /status response
    await adapter.simulateInbound(baseMsg);
    assert.ok(adapter.sent.at(-1)?.text.includes('当前通道状态'));

    // Unbind revokes access immediately
    const unboundSnap = await manager.unbindAccount('telegram', '777');
    assert.equal(unboundSnap.bindings.length, 0);
    await adapter.simulateInbound(baseMsg);
    assert.ok(adapter.sent.at(-1)?.text.includes('配对码'));
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
