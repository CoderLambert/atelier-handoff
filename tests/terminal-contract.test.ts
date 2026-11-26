/**
 * @file 验证人工终端的身份与传输契约。
 * @implementation 使用共享 schema 检查未知执行参数、帧大小和二进制输入，核对 Unicode 输入分块不损坏字符或突破完整 JSON 限额。
 * @updated 2026-11-26T04:09:19+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  terminalClientFrameSchema,
  terminalCreateRequestSchema,
  terminalServerFrameSchema,
  splitTerminalInput,
} from '../shared/terminal.js';

const runtimeId = '11111111-1111-4111-8111-111111111111';
const terminalId = '22222222-2222-4222-8222-222222222222';
const attachmentId = '33333333-3333-4333-8333-333333333333';

test('terminal creation accepts only a runtime-bound identity and bounded geometry', () => {
  const request = { runtimeId, terminalId, expectedWorkspaceId: null, cols: 80, rows: 24 };
  assert.deepEqual(terminalCreateRequestSchema.parse(request), request);
  for (const extra of [
    { cwd: '/tmp' },
    { command: 'sh' },
    { env: {} },
    { cols: 0 },
    { rows: 201 },
  ]) {
    assert.equal(terminalCreateRequestSchema.safeParse({ ...request, ...extra }).success, false);
  }
});

test('terminal frames reject unaffiliated, oversized and malformed binary input', () => {
  const input = {
    type: 'input',
    attachmentId,
    inputSeq: 1,
    payload: { encoding: 'binary', base64: '/wAA' },
  };
  assert.equal(terminalClientFrameSchema.safeParse(input).success, true);
  for (const payload of [
    { encoding: 'binary', base64: '?!' },
    { encoding: 'binary', base64: Buffer.alloc(65_537).toString('base64') },
    { encoding: 'utf8', data: '中'.repeat(22_000) },
  ])
    assert.equal(terminalClientFrameSchema.safeParse({ ...input, payload }).success, false);
  assert.equal(
    terminalClientFrameSchema.safeParse({ ...input, attachmentId: 'old' }).success,
    false,
  );
  assert.equal(terminalClientFrameSchema.safeParse({ ...input, inputSeq: 0 }).success, false);
  assert.equal(
    terminalServerFrameSchema.safeParse({ type: 'output', attachmentId, seq: -1, data: '' })
      .success,
    false,
  );
});

test('pasted input preserves Unicode and bounds complete JSON frames including escaping', () => {
  const source = '中😀\u0000\n\"\\'.repeat(30_000);
  const pieces = splitTerminalInput(source, attachmentId, 7);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.map((frame) => frame.payload.data).join(''), source);
  for (const [index, frame] of pieces.entries()) {
    assert.equal(frame.inputSeq, index + 7);
    assert.ok(Buffer.byteLength(frame.payload.data) <= 65_536);
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= 131_072);
    assert.equal(terminalClientFrameSchema.safeParse(frame).success, true);
    assert.equal(frame.payload.data.includes('\ufffd'), false);
  }
});
