/**
 * @file 验证终端附件会话双水位流控、单次序列化透传与搜索技能代理规则。
 * @implementation 使用纯内存 mock 连接与无进程断言覆盖 TerminalAttachmentSession 及 search-skill-broker 的边界行为。
 * @updated 2026-11-27T22:10:00+08:00
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  OUTPUT_PAUSE_BYTES,
  OUTPUT_RESUME_BYTES,
  TerminalAttachmentSession,
  type TerminalConnection,
} from '../server/modules/terminal/attachment-session.js';
import type { TerminalScreen } from '../server/modules/terminal/screen.js';
import {
  isAllowedSearchBrokerRequest,
  rewriteSearchCheckoutOutput,
  validateSearchSkillArgs,
} from '../server/search-skill-broker.js';
import {
  terminalLimits,
  type TerminalRecord,
  type TerminalServerFrame,
} from '../shared/terminal.js';

function sampleRecord(state: TerminalRecord['state'] = 'running'): TerminalRecord {
  return {
    runtimeId: 'rt-1',
    terminalId: 'term-1',
    sessionId: 'sess-1',
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    initialCwd: '/tmp/project',
    shellName: 'bash',
    cols: 80,
    rows: 24,
    state,
    createdAt: '2026-11-27T00:00:00.000Z',
    exitCode: null,
    exitSignal: null,
  };
}

describe('TerminalAttachmentSession', () => {
  test('pre-serializes snapshot/output once, holds snapshot fence until ready, and releases dual-watermark pauses', async () => {
    const sent: Array<{ frame: TerminalServerFrame; encoded?: string }> = [];
    const closedCodes: string[] = [];
    const pauseEvents: Array<{ reason: string; paused: boolean }> = [];
    let closedCallbackCount = 0;

    const connection: TerminalConnection = {
      bufferedAmount: 0,
      send(frame, encoded) {
        sent.push({ frame, encoded });
      },
      close(code) {
        closedCodes.push(code);
      },
    };

    const session = new TerminalAttachmentSession('att-1', connection, 5, {
      onSetPause(reason, paused) {
        pauseEvents.push({ reason, paused });
      },
      onClosed() {
        closedCallbackCount += 1;
      },
    });

    const screen = { serialize: () => 'hello-screen' } as unknown as TerminalScreen;
    let fenceSettled = false;
    const snapshotPromise = session.sendSnapshotAndWait(5, screen, sampleRecord()).then(() => {
      fenceSettled = true;
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.frame.type, 'snapshot');
    assert.equal(typeof sent[0]?.encoded, 'string');
    assert.equal(sent[0]?.encoded, JSON.stringify(sent[0]?.frame));
    assert.equal(fenceSettled, false);

    session.completeReady(true, sampleRecord());
    await snapshotPromise;
    assert.equal(fenceSettled, true);
    assert.equal(session.ready, true);
    assert.equal(sent[1]?.frame.type, 'readyAccepted');
    assert.deepEqual(pauseEvents.at(-1), { reason: 'att-1', paused: false });

    // Fill output window up to pause watermark (384 KiB).
    const chunkPayload = 'a'.repeat(OUTPUT_PAUSE_BYTES / 2);
    session.sendFrame({ type: 'output', attachmentId: 'att-1', seq: 6, data: chunkPayload });
    assert.equal(session.shouldPauseOutput(), false);
    session.sendFrame({ type: 'output', attachmentId: 'att-1', seq: 7, data: chunkPayload });
    assert.equal(session.shouldPauseOutput(), true);
    assert.equal(typeof sent[2]?.encoded, 'string');

    let waited = false;
    const waitPromise = session.waitForOutputCapacity().then(() => {
      waited = true;
    });
    assert.deepEqual(pauseEvents.at(-1), { reason: 'att-1', paused: true });

    // Partial ACK leaving bytes above OUTPUT_RESUME_BYTES keeps waiting.
    session.acknowledgeOutput(6);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(waited, false);
    assert.ok(session.pendingOutputBytes > OUTPUT_RESUME_BYTES);

    // Full ACK drops to <= resume watermark and releases wait.
    session.acknowledgeOutput(7);
    await waitPromise;
    assert.equal(waited, true);
    assert.deepEqual(pauseEvents.at(-1), { reason: 'att-1', paused: false });

    // Exceeding hard 512 KiB output window closes slow consumer.
    const bigPayload = 'b'.repeat(terminalLimits.outputWindowBytes);
    session.sendFrame({ type: 'output', attachmentId: 'att-1', seq: 8, data: bigPayload });
    assert.equal(session.closed, true);
    assert.deepEqual(closedCodes, ['TERMINAL_SLOW_CONSUMER']);
    assert.equal(closedCallbackCount, 1);

    session.close();
  });

  test('enforces monotonic input, command, and output ACK sequence bounds', () => {
    const connection: TerminalConnection = {
      bufferedAmount: 0,
      send() {},
      close() {},
    };
    const session = new TerminalAttachmentSession('att-2', connection, 10, {
      onSetPause() {},
      onClosed() {},
    });

    session.acceptInputSeq(1);
    assert.throws(() => session.acceptInputSeq(1), { code: 'TERMINAL_PROTOCOL_ERROR' });
    assert.throws(() => session.acceptInputSeq(3), { code: 'TERMINAL_PROTOCOL_ERROR' });

    session.acceptCommandSeq(1);
    assert.throws(() => session.acceptCommandSeq(3), { code: 'TERMINAL_PROTOCOL_ERROR' });

    assert.throws(() => session.acknowledgeOutput(9), { code: 'TERMINAL_PROTOCOL_ERROR' });
    assert.throws(() => session.acknowledgeOutput(11), { code: 'TERMINAL_PROTOCOL_ERROR' });
    session.close();
  });
});

describe('search-skill-broker', () => {
  test('validates stage names and forbids caller-overridden --base-url or --state', () => {
    assert.doesNotThrow(() => validateSearchSkillArgs(['prepare', '--query', 'ts']));
    assert.doesNotThrow(() => validateSearchSkillArgs(['execute']));
    assert.doesNotThrow(() => validateSearchSkillArgs(['collect']));
    assert.throws(() => validateSearchSkillArgs(['retry']), {
      code: 'SKILL_PACKAGE_EXECUTION_INVALID',
    });
    assert.throws(() => validateSearchSkillArgs(['prepare', '--base-url=http://evil']), {
      code: 'SKILL_PACKAGE_EXECUTION_INVALID',
    });
    assert.throws(() => validateSearchSkillArgs(['prepare', '--state', '/etc']), {
      code: 'SKILL_PACKAGE_EXECUTION_INVALID',
    });
  });

  test('restricts routes strictly and only permits /invoke during execute', () => {
    const taskId = 'a'.repeat(32);
    assert.equal(isAllowedSearchBrokerRequest('POST', '/api/v1/clients/register', false), true);
    assert.equal(
      isAllowedSearchBrokerRequest('POST', '/api/v1/skills/multi-search-engine/invoke', false),
      false,
    );
    assert.equal(
      isAllowedSearchBrokerRequest('POST', '/api/v1/skills/multi-search-engine/invoke', true),
      true,
    );
    assert.equal(
      isAllowedSearchBrokerRequest('POST', `/api/v1/multi-search/tasks/${taskId}/recover`, false),
      true,
    );
    assert.equal(
      isAllowedSearchBrokerRequest(
        'GET',
        `/api/v1/multi-search/requests/req_123456?quote_id=${taskId}`,
        false,
      ),
      true,
    );
    assert.equal(
      isAllowedSearchBrokerRequest('GET', `/api/v1/multi-search/tasks/${taskId}/files/0`, false),
      true,
    );
    assert.equal(
      isAllowedSearchBrokerRequest('GET', `/api/v1/multi-search/tasks/${taskId}/files/3`, false),
      false,
    );
    assert.equal(isAllowedSearchBrokerRequest('GET', '/api/v1/clients/../secret', false), false);
  });

  test('rewrites logical gateway checkout URL to official search origin', () => {
    const rewritten = rewriteSearchCheckoutOutput(
      'Open http://127.0.0.1:17863/checkout#token=abc to pay.',
    );
    assert.equal(rewritten, 'Open https://skill.zhaopintong.com/checkout#token=abc to pay.');
  });
});
