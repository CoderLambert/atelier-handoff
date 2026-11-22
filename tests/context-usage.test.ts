/**
 * @file 验证 SDK 窗口摘要和最近请求的缓存语义。
 * @implementation 使用结构化 SDK 夹具检查保存边界、分类、缺失计数和有界采样。
 * @updated 2026-11-23T03:40:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { cacheHitRatio, contextStats } from '../shared/context-usage.js';
import { sampleContextUsage } from '../server/context-usage.js';

const sdkContext: SDKControlGetContextUsageResponse = {
  model: 'fixture-model',
  rawMaxTokens: 100_000,
  maxTokens: 200_000,
  totalTokens: 30_000,
  percentage: 30,
  categories: [
    { id: 'messages', name: 'Messages', kind: 'used', tokens: 30_000, color: '' },
    { id: 'free_space', name: 'Free space', kind: 'free', tokens: 60_000, color: '' },
    { id: 'autocompact_buffer', name: 'Reserve', kind: 'buffer', tokens: 10_000, color: '' },
    { id: 'mcp_tools_deferred', name: 'Deferred', kind: 'deferred', tokens: 20_000, color: '' },
  ],
  agents: [],
  mcpTools: [],
  memoryFiles: [],
  gridRows: [],
  isAutoCompactEnabled: true,
  messageBreakdown: {
    userMessageTokens: 10_000,
    assistantMessageTokens: 1_000,
    toolCallTokens: 500,
    toolResultTokens: 16_000,
    attachmentTokens: 500,
    redirectedContextTokens: 2_000,
    unattributedTokens: 0,
    toolCallsByType: [],
    attachmentsByType: [],
  },
  apiUsage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 60,
    cache_creation_input_tokens: 30,
  },
};

test('SDK summary uses the effective window and the matching latest request counters', async () => {
  const sample = await sampleContextUsage(
    {
      getContextUsage: async (options) => {
        assert.deepEqual(options, { detail: 'summary' });
        return sdkContext;
      },
    },
    'fixture-session',
    new AbortController().signal,
  );
  assert.ok(sample);
  assert.equal(sample.sdkSessionId, 'fixture-session');
  assert.equal(sample.model, 'fixture-model');
  assert.equal(sample.windowTokens, 100_000);
  assert.deepEqual(contextStats(sample), {
    reservedTokens: 10_000,
    remainingTokens: 60_000,
    remainingRatio: 0.6,
    usedRatio: 0.3,
  });
  assert.equal(cacheHitRatio(sample.requestUsage), 0.6);
  assert.equal(sample.messageBreakdown?.toolResultTokens, 16_000);
  assert.equal('color' in sample.categories[0]!, false);
  assert.deepEqual(contextStats({ ...sample, usedTokens: 110_000 }), {
    reservedTokens: 10_000,
    remainingTokens: 0,
    remainingRatio: 0,
    usedRatio: 1.1,
  });
});

test('zero cache hits, missing counters, and no input are distinct', () => {
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 };
  assert.equal(cacheHitRatio(usage), 0);
  assert.equal(cacheHitRatio({ ...usage, cacheCreationTokens: null }), null);
  assert.equal(cacheHitRatio({ ...usage, inputTokens: 0 }), null);
  assert.equal(cacheHitRatio(null), null);
});

test('sampling has a deadline and can stop before the SDK resolves', async () => {
  const signal = new AbortController();
  const pending: Promise<SDKControlGetContextUsageResponse> = new Promise(() => {});
  assert.equal(
    await sampleContextUsage(
      { getContextUsage: () => pending },
      'fixture-session',
      signal.signal,
      10,
    ),
    undefined,
  );
  let resolve!: (value: SDKControlGetContextUsageResponse) => void;
  const late = new Promise<SDKControlGetContextUsageResponse>((done) => {
    resolve = done;
  });
  const sampling = sampleContextUsage(
    { getContextUsage: () => late },
    'fixture-session',
    signal.signal,
  );
  signal.abort();
  assert.equal(await sampling, undefined);
  resolve(sdkContext);
});
