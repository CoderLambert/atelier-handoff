/**
 * @file 验证终端选择的会话与运行时隔离。
 * @implementation 直接检验 UI reducer，确认旧运行时的迟到选择不能覆盖新运行时。
 * @updated 2026-11-26T01:00:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalSelectionReducer } from './terminal-ui-state';

test('terminal choices stay isolated by session and late old-runtime selection is ignored', () => {
  const initial = {
    runtimeId: 'runtime-a',
    sessions: { first: 'terminal-one', second: 'terminal-two' },
  };
  const selected = terminalSelectionReducer(initial, {
    type: 'select',
    runtimeId: 'runtime-a',
    sessionId: 'first',
    terminalId: 'terminal-three',
  });
  assert.deepEqual(selected.sessions, { first: 'terminal-three', second: 'terminal-two' });
  assert.deepEqual(initial.sessions, { first: 'terminal-one', second: 'terminal-two' });
  const switched = terminalSelectionReducer(selected, { type: 'runtime', runtimeId: 'runtime-b' });
  assert.deepEqual(switched, { runtimeId: 'runtime-b', sessions: {} });
  assert.equal(
    terminalSelectionReducer(switched, {
      type: 'select',
      runtimeId: 'runtime-a',
      sessionId: 'first',
      terminalId: 'terminal-old',
    }),
    switched,
  );
});

test('closing the last terminal removes only that session selection', () => {
  const initial = {
    runtimeId: 'runtime-a',
    sessions: { first: 'terminal-one', second: 'terminal-two' },
  };
  assert.deepEqual(
    terminalSelectionReducer(initial, {
      type: 'select',
      runtimeId: 'runtime-a',
      sessionId: 'first',
    }).sessions,
    { second: 'terminal-two' },
  );
});
