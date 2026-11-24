/**
 * @file 验证 AI 多提交短期会话的恢复、身份隔离与容量边界。
 * @implementation 使用合成单元与可控规划器验证进度作用域、取消、续跑、并发、过期和容量限制。
 * @updated 2026-11-24T22:06:05+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CommitAnalysisSessions,
  commitAnalysisCandidates,
  commitAnalysisLimits,
  type CommitAnalysisScope,
} from '../server/modules/git/commit-analysis-sessions.js';
import type {
  CommitPlan,
  CommitPlanCoverage,
  CommitPlanResult,
  suggestCommitPlan,
} from '../server/modules/git/commit-planner.js';
import {
  multiCommitAnalysis,
  multiCommitDraftRequest,
  type MultiCommitUnit,
} from '../shared/git-multi-commit.js';
import { AppError, reasoningEfforts, type AppConfig } from '../shared/types.js';

const scope: CommitAnalysisScope = {
  projectId: 'project',
  worktreeId: 'tree',
  version: 'version',
  repositoryId: 'repository',
  rootIdentity: 'root',
  adminIdentity: 'admin',
};
const config: AppConfig = {
  gateway: 'http://127.0.0.1:1',
  model: 'fixture',
  maxTurns: 1,
  timeoutMs: 1000,
};
const candidates = [
  {
    id: 'a',
    path: 'a.ts',
    layer: 'unstaged' as const,
    description: 'Change a',
    diff: '+synthetic',
  },
  { id: 'b', path: 'b.ts', layer: 'untracked' as const, description: 'Change b' },
];
const coverage = (complete = true): CommitPlanCoverage => ({
  batchCount: 2,
  completedBatchCount: complete ? 2 : 1,
  completedUnitIds: complete ? ['a', 'b'] : ['a'],
  globalPass: complete ? 'completed' : 'pending',
  diffUnitIds: ['a'],
  metadataOnlyUnitIds: ['b'],
});
const plan: CommitPlan = {
  groups: [{ title: 'Change a', body: '', unitIds: ['a'] }],
  unassignedUnitIds: ['b'],
};
const result = (): CommitPlanResult => ({
  status: 'ready',
  ...structuredClone(plan),
  coverage: coverage(),
});
const input = (analysisId = randomUUID()) => ({
  scope: { ...scope },
  config: { ...config },
  locale: 'en' as const,
  candidates: structuredClone(candidates),
  analysisId,
  generate: true,
  signal: new AbortController().signal,
});
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === 'GIT_PLAN_ANALYSIS_' + expected;

test('shared analysis requests remain backwards compatible and resume requires an ID', () => {
  assert.deepEqual(multiCommitDraftRequest.parse({ locale: 'en', generate: true }), {
    locale: 'en',
    generate: true,
  });
  for (const effort of reasoningEfforts) {
    assert.equal(
      multiCommitDraftRequest.parse({ locale: 'en', generate: true, effort }).effort,
      effort,
    );
  }
  for (const effort of [null, '', 'auto', 'ultra', 42]) {
    assert.equal(
      multiCommitDraftRequest.safeParse({ locale: 'en', generate: true, effort }).success,
      false,
    );
  }
  assert.equal(
    multiCommitDraftRequest.safeParse({ locale: 'en', generate: false, resume: true }).success,
    false,
  );
  assert.equal(
    multiCommitDraftRequest.safeParse({
      locale: 'en',
      generate: false,
      resume: true,
      analysisId: randomUUID(),
      checkpoint: {},
    }).success,
    false,
  );
});

test('AI candidates exclude unsupported, rename and dependent units without disclosing their metadata', () => {
  const unit = (id: string, fields: Partial<MultiCommitUnit> = {}): MultiCommitUnit => ({
    id,
    path: id + '.ts',
    layer: 'unstaged',
    kind: 'atomic',
    description: 'Synthetic',
    reason: null,
    dependsOn: [],
    ...fields,
  });
  const units = [
    unit('safe', { diff: '+safe' }),
    unit('rename', { reason: 'rename', path: 'private-rename.ts' }),
    unit('secret', { kind: 'unsupported', description: 'SYNTHETIC_SECRET_DO_NOT_SEND' }),
    unit('child', { dependsOn: ['rename'] }),
    unit('grandchild', { dependsOn: ['child'] }),
  ];
  const selected = commitAnalysisCandidates(units);
  assert.deepEqual(
    selected.map((candidate) => candidate.id),
    ['safe'],
  );
  assert.doesNotMatch(JSON.stringify(selected), /private-rename|SYNTHETIC_SECRET|child/);
  assert.equal(units.length, 5);
});

test('an in-flight session supports passive reads, rejects duplicate model work, and cancellation resumes validated batches', async () => {
  let calls = 0;
  let announceStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const first: CommitPlan = { groups: plan.groups, unassignedUnitIds: [] };
  const planner: typeof suggestCommitPlan = async (_config, _locale, _units, signal, options) => {
    calls++;
    if (calls === 1) {
      options?.onProgress?.(
        { batches: [first] },
        { status: 'ready', ...plan, coverage: coverage(false) },
      );
      announceStarted?.();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return { status: 'manual', reason: 'cancelled', ...plan, coverage: coverage(false) };
    }
    assert.deepEqual(options?.checkpoint, { batches: [first] });
    assert.equal(options?.timeoutMs, 120_000);
    const completed = result();
    options?.onProgress?.(
      { batches: [first, { groups: [], unassignedUnitIds: ['b'] }], finalPlan: plan },
      completed,
    );
    return completed;
  };
  const sessions = new CommitAnalysisSessions({ planner });
  const request = input();
  const abort = new AbortController();
  try {
    const pending = sessions.analyze({ ...request, signal: abort.signal });
    await started;
    const current = await sessions.analyze({ ...request, generate: false, resume: true });
    assert.equal(current.analysis.state, 'running');
    assert.equal(current.analysis.reason, null);
    assert.equal(current.analysis.canResume, false);
    assert.deepEqual(current.analysis.completedUnitIds, ['a']);
    assert.deepEqual(sessions.progress(request.scope, request.analysisId), {
      stage: 'batch',
      batchCount: 2,
      completedBatchCount: 1,
      analyzed: 1,
      suggestedGroups: 1,
    });
    for (const key of ['projectId', 'worktreeId', 'version'] as const) {
      assert.equal(
        sessions.progress({ ...request.scope, [key]: 'other' }, request.analysisId),
        null,
      );
    }
    assert.equal(sessions.progress(request.scope, randomUUID()), null);
    multiCommitAnalysis.parse(current.analysis);
    await assert.rejects(sessions.analyze(request), code('BUSY'));
    abort.abort();
    const partial = await pending;
    assert.equal(partial.analysis.state, 'partial');
    assert.equal(partial.analysis.reason, 'cancelled');
    assert.equal(partial.analysis.canResume, true);
    assert.equal(sessions.progress(request.scope, request.analysisId), null);
    assert.deepEqual(partial.groups, current.groups);
    const completed = await sessions.analyze({ ...request, resume: true });
    assert.equal(completed.analysis.state, 'complete');
    assert.deepEqual(completed.analysis.completedUnitIds, ['a', 'b']);
    assert.deepEqual(completed.groups, partial.groups);
    assert.deepEqual(completed.result.unassignedUnitIds, ['b']);
    assert.equal(calls, 2);
    await sessions.analyze(request);
    await sessions.analyze({ ...request, generate: false, resume: true });
    assert.equal(calls, 2);
  } finally {
    sessions.close();
  }
});

test('every scope, model, effort, locale, gateway and disclosure change rejects reuse before planning', async () => {
  let calls = 0;
  const sessions = new CommitAnalysisSessions({
    planner: async () => {
      calls++;
      return result();
    },
  });
  const request = { ...input(), instruction: 'Group changes by feature' };
  try {
    await sessions.analyze(request);
    for (const key of Object.keys(scope) as (keyof CommitAnalysisScope)[]) {
      await assert.rejects(
        sessions.analyze({ ...request, resume: true, scope: { ...scope, [key]: 'changed' } }),
        code('STALE'),
      );
    }
    const configChanges: Partial<AppConfig>[] = [
      { model: 'other' },
      { gateway: 'http://127.0.0.1:2' },
      { effort: 'high' },
    ];
    for (const configChange of configChanges) {
      await assert.rejects(
        sessions.analyze({ ...request, resume: true, config: { ...config, ...configChange } }),
        code('STALE'),
      );
    }
    await assert.rejects(
      sessions.analyze({ ...request, resume: true, locale: 'zh-CN' }),
      code('STALE'),
    );
    for (const instruction of ['Group changes by path', undefined]) {
      await assert.rejects(
        sessions.analyze({ ...request, resume: true, instruction }),
        code('STALE'),
      );
    }
    await assert.rejects(
      sessions.analyze({
        ...request,
        resume: true,
        candidates: [
          {
            ...candidates[0],
            id: 'new',
            path: 'new.ts',
            layer: 'unstaged',
            description: 'New',
            diff: '+changed',
          },
        ],
      }),
      code('STALE'),
    );
    assert.equal(calls, 1);
    const response = await sessions.analyze({ ...request, generate: false });
    response.groups[0]?.unitIds.push('client-mutation');
    response.result.coverage.completedUnitIds.push('client-mutation');
    const reread = await sessions.analyze({ ...request, generate: false });
    assert.deepEqual(reread.groups[0]?.unitIds, ['a']);
    assert.deepEqual(reread.analysis.completedUnitIds, ['a', 'b']);
  } finally {
    sessions.close();
  }
});

test('partial sessions retain their effort and reject changing or clearing it before resume', async () => {
  let calls = 0;
  const sessions = new CommitAnalysisSessions({
    planner: async (settings) => {
      calls++;
      assert.equal(settings.effort, 'high');
      return { ...result(), status: 'manual', reason: 'timeout', coverage: coverage(false) };
    },
  });
  const request = { ...input(), config: { ...config, effort: 'high' as const } };
  try {
    const partial = await sessions.analyze(request);
    for (const effort of [undefined, 'low'] as const) {
      for (const generate of [false, true]) {
        await assert.rejects(
          sessions.analyze({
            ...request,
            resume: true,
            generate,
            config: { ...config, effort },
          }),
          code('STALE'),
        );
      }
    }
    assert.equal(calls, 1);
    const retained = await sessions.analyze({ ...request, resume: true, generate: false });
    assert.deepEqual(retained.groups, partial.groups);
    await sessions.analyze({ ...request, resume: true });
    assert.equal(calls, 2);
  } finally {
    sessions.close();
  }
});

test('credential changes reject resume without exposing or resending the old plan', async () => {
  const original = process.env.ATELIER_GATEWAY_TOKEN;
  let calls = 0;
  const sessions = new CommitAnalysisSessions({
    planner: async () => {
      calls++;
      return result();
    },
  });
  const request = input();
  try {
    process.env.ATELIER_GATEWAY_TOKEN = 'test-token';
    await sessions.analyze(request);
    process.env.ATELIER_GATEWAY_TOKEN = 'dummy-token';
    await assert.rejects(sessions.analyze({ ...request, resume: true }), code('STALE'));
    assert.equal(calls, 1);
  } finally {
    if (original === undefined) delete process.env.ATELIER_GATEWAY_TOKEN;
    else process.env.ATELIER_GATEWAY_TOKEN = original;
    sessions.close();
  }
});

test('an incomplete session is not evicted before its advertised expiry', async () => {
  let clock = 1000;
  let calls = 0;
  const sessions = new CommitAnalysisSessions({
    now: () => clock,
    ttlMs: 100,
    maxSessions: 1,
    planner: async () => {
      calls++;
      return { ...result(), status: 'manual', reason: 'timeout', coverage: coverage(false) };
    },
  });
  const first = input();
  try {
    const partial = await sessions.analyze(first);
    await assert.rejects(sessions.analyze(input()), code('BUSY'));
    const retained = await sessions.analyze({ ...first, generate: false, resume: true });
    assert.equal(retained.analysis.expiresAt, partial.analysis.expiresAt);
    assert.equal(retained.analysis.completedBatchCount, 1);
    assert.equal(calls, 1);
    clock += 101;
    await sessions.analyze(input());
    assert.equal(calls, 2);
  } finally {
    sessions.close();
  }
});

test('unknown, expired, evicted and restarted sessions fail explicitly without starting a model', async () => {
  let clock = 1000;
  let calls = 0;
  const sessions = new CommitAnalysisSessions({
    now: () => clock,
    ttlMs: 100,
    maxSessions: 1,
    planner: async () => {
      calls++;
      return result();
    },
  });
  const first = input();
  try {
    await assert.rejects(sessions.analyze({ ...first, resume: true }), code('EXPIRED'));
    await sessions.analyze(first);
    const second = input();
    await sessions.analyze(second);
    await assert.rejects(
      sessions.analyze({ ...first, generate: false, resume: true }),
      code('EXPIRED'),
    );
    clock += 101;
    await assert.rejects(
      sessions.analyze({ ...second, generate: false, resume: true }),
      code('EXPIRED'),
    );
    assert.equal(calls, 2);
    sessions.close();
    await assert.rejects(sessions.analyze(first), code('CLOSED'));
    const restarted = new CommitAnalysisSessions({
      planner: async () => {
        calls++;
        return result();
      },
    });
    try {
      await assert.rejects(restarted.analyze({ ...first, resume: true }), code('EXPIRED'));
    } finally {
      restarted.close();
    }
    assert.equal(calls, 2);
  } finally {
    sessions.close();
  }
});

test('running sessions cannot be evicted and application shutdown cancels their request', async () => {
  let announceStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  const sessions = new CommitAnalysisSessions({
    maxSessions: 1,
    planner: async (_config, _locale, _units, signal) => {
      announceStarted?.();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return { ...result(), status: 'manual', reason: 'cancelled' };
    },
  });
  try {
    const pending = sessions.analyze(input());
    await started;
    await assert.rejects(sessions.analyze(input()), code('BUSY'));
    sessions.close();
    assert.equal((await pending).analysis.reason, 'cancelled');
  } finally {
    sessions.close();
  }
});

test('over 120 validated groups stay available with an explicit group-limit and retained global retry', async () => {
  const many = Array.from({ length: 129 }, (_, index) => ({
    id: 'unit-' + index,
    path: 'file-' + index,
    layer: 'unstaged' as const,
    description: 'Synthetic',
  }));
  const groups = many.map((unit) => ({ title: 'Change ' + unit.id, body: '', unitIds: [unit.id] }));
  const batches: CommitPlan[] = [0, 64, 128].map((start) => ({
    groups: groups.slice(start, start + 64),
    unassignedUnitIds: [],
  }));
  let calls = 0;
  const sessions = new CommitAnalysisSessions({
    planner: async (_config, _locale, _units, _signal, options) => {
      calls++;
      if (calls > 1) assert.deepEqual(options?.checkpoint, { batches });
      const value: CommitPlanResult = {
        status: 'ready',
        groups,
        unassignedUnitIds: [],
        coverage: {
          batchCount: 3,
          completedBatchCount: 3,
          completedUnitIds: many.map((unit) => unit.id),
          globalPass: 'completed',
          diffUnitIds: [],
          metadataOnlyUnitIds: many.map((unit) => unit.id),
        },
      };
      options?.onProgress?.({ batches, finalPlan: { groups, unassignedUnitIds: [] } }, value);
      return value;
    },
  });
  const request = { ...input(), candidates: many };
  try {
    const limited = await sessions.analyze(request);
    assert.equal(limited.analysis.reason, 'group-limit');
    assert.equal(limited.analysis.groupLimitReached, true);
    assert.equal(limited.analysis.canResume, true);
    assert.equal(limited.groups.length, commitAnalysisLimits.maxVisibleGroups);
    assert.equal(limited.result.groups.length, 129);
    assert.deepEqual(
      limited.analysis.completedUnitIds,
      many.map((unit) => unit.id),
    );
    const assigned = new Set(limited.groups.flatMap((group) => group.unitIds));
    assert.equal(many.filter((unit) => !assigned.has(unit.id)).length, 9);
    const resumed = await sessions.analyze({ ...request, resume: true });
    assert.deepEqual(resumed.groups, limited.groups);
    assert.equal(calls, 2);
  } finally {
    sessions.close();
  }
});
