/**
 * @file 定义多提交分析、对话修改、审查、预览和执行的共享契约。
 * @implementation 以服务端变更单元 ID 关联分组，定义分析恢复、对话上下文和凭据位置。确认请求携带计划、摘要及操作 ID。
 * @updated 2026-11-27T21:40:00+08:00
 */
import { z } from 'zod';
import { gitCommitMessage, gitDiffLayer, gitPath, gitOid } from './git-workbench.js';
import { uiLocaleSchema } from './i18n/locale.js';
import { gatewayModelSchema, reasoningEfforts } from './models.js';

export const MAX_MULTI_COMMIT_GROUPS = 120;

export const gitMultiCommitPreferences = z.strictObject({
  model: gatewayModelSchema.shape.id.nullable(),
  effort: z.enum(reasoningEfforts).nullable(),
});
export type GitMultiCommitPreferences = z.infer<typeof gitMultiCommitPreferences>;

const unitId = z.string().min(1).max(256);
const version = z.string().min(1).max(256);
const multiCommitCredential = z.strictObject({
  rule: z.enum(['format', 'literal']),
  location: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('path') }),
    z.strictObject({ kind: z.enum(['addition', 'deletion', 'context']), line: z.int().positive() }),
  ]),
});
export type MultiCommitCredential = z.infer<typeof multiCommitCredential>;

export function commitCredentialBlocksLocal(finding: MultiCommitCredential | undefined): boolean {
  return finding?.location.kind === 'addition' || finding?.location.kind === 'path';
}

export const multiCommitUnit = z.strictObject({
  id: unitId,
  path: gitPath,
  layer: gitDiffLayer,
  kind: z.enum(['hunk', 'atomic', 'unsupported']),
  description: z.string().max(2048),
  reason: z.string().max(2048).nullable(),
  dependsOn: z.array(unitId).max(4096),
  /** No matched value is included. Any finding withholds the entire unit from the model. */
  credential: multiCommitCredential.optional(),
  diff: z
    .string()
    .max(128 * 1024)
    .optional(),
});
export const multiCommitGroup = gitCommitMessage.extend({
  id: z.uuid(),
  unitIds: z.array(unitId).min(1).max(4096),
});
export const multiCommitInstruction = z.string().trim().min(1).max(2000);
const editableCommitGroup = multiCommitGroup.extend({
  title: z.string().max(240),
  unitIds: z.array(unitId).max(4096),
});
const editableCommitPlan = z.strictObject({
  groups: z.array(editableCommitGroup).max(MAX_MULTI_COMMIT_GROUPS),
  excludedUnitIds: z.array(unitId).max(4096),
});
export const multiCommitRevisionRequest = editableCommitPlan.extend({
  version,
  locale: uiLocaleSchema,
  model: gatewayModelSchema.shape.id,
  effort: z.enum(reasoningEfforts).optional(),
  instruction: multiCommitInstruction,
  previousTurns: z
    .array(z.strictObject({ instruction: multiCommitInstruction, note: z.string().max(1000) }))
    .max(3)
    .optional(),
});
export const multiCommitRevisionResponse = editableCommitPlan.extend({
  note: z.string().max(1000),
});
export type MultiCommitRevisionRequest = z.infer<typeof multiCommitRevisionRequest>;

export const multiCommitDraftRequest = z
  .strictObject({
    locale: uiLocaleSchema,
    generate: z.boolean(),
    model: gatewayModelSchema.shape.id.optional(),
    effort: z.enum(reasoningEfforts).optional(),
    instruction: multiCommitInstruction.optional(),
    /** Generate and resume against the snapshot the user chose to analyze. */
    version: version.optional(),
    /** A client-created ID lets cancellation recover an attempt whose response was disconnected. */
    analysisId: z.uuid().optional(),
    resume: z.boolean().optional(),
  })
  .refine((input) => !input.resume || Boolean(input.analysisId), {
    message: 'Resuming requires an analysis ID.',
  });
export const multiCommitAnalysis = z.strictObject({
  id: z.uuid(),
  state: z.enum(['running', 'partial', 'complete']),
  reason: z.string().max(256).nullable(),
  batchCount: z.int().nonnegative(),
  completedBatchCount: z.int().nonnegative(),
  completedUnitIds: z.array(unitId).max(4096),
  globalPass: z.enum(['not-needed', 'pending', 'completed']),
  canResume: z.boolean(),
  groupLimitReached: z.boolean(),
  expiresAt: z.iso.datetime(),
});
export const multiCommitProgressRequest = z.strictObject({ analysisId: z.uuid(), version });
const multiCommitProgress = z.strictObject({
  stage: z.enum(['preparing', 'batch', 'organizing', 'finishing']),
  batchCount: z.int().nonnegative(),
  completedBatchCount: z.int().nonnegative(),
  analyzed: z.int().nonnegative(),
  suggestedGroups: z.int().nonnegative(),
});
export const multiCommitProgressResponse = z.strictObject({
  progress: multiCommitProgress.nullable(),
});
export type MultiCommitProgressRequest = z.infer<typeof multiCommitProgressRequest>;
export type MultiCommitProgress = z.infer<typeof multiCommitProgress>;

export const multiCommitDraft = z.strictObject({
  version,
  branch: z.string().nullable(),
  units: z.array(multiCommitUnit).max(4096),
  groups: z.array(multiCommitGroup).max(MAX_MULTI_COMMIT_GROUPS),
  modelCandidateIds: z.array(unitId).max(4096),
  unassignedUnitIds: z.array(unitId).max(4096),
  suggestionStatus: z.enum(['ready', 'partial', 'manual']),
  suggestionReason: z.string().max(256).nullable(),
  analysis: multiCommitAnalysis.optional(),
  /** 本次尝试分析的完整模型 ID，不表示分析成功；请求前降级或手动草稿省略。 */
  analysisModel: gatewayModelSchema.shape.id.optional(),
  coverage: z.strictObject({
    analyzed: z.number().int().nonnegative(),
    metadataOnly: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  }),
});
export const multiCommitValidate = z.strictObject({
  version,
  groups: z.array(multiCommitGroup).min(1).max(MAX_MULTI_COMMIT_GROUPS),
  excludedUnitIds: z.array(unitId).max(4096),
});
export const multiCommitPreview = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  groups: z
    .array(
      z.strictObject({
        id: z.uuid(),
        files: z.array(z.strictObject({ path: gitPath, text: z.string(), binary: z.boolean() })),
      }),
    )
    .max(MAX_MULTI_COMMIT_GROUPS),
});
export const multiCommitSubmit = multiCommitValidate.extend({
  operationId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const multiCommitReceipt = z.strictObject({
  operationId: z.uuid(),
  commits: z.array(gitOid).min(1).max(MAX_MULTI_COMMIT_GROUPS),
});
export const multiCommitPending = z.strictObject({
  items: z
    .array(
      z.strictObject({
        operationId: z.uuid(),
        state: z.enum(['prepared', 'ref_updated', 'aborting', 'recovery_required']),
        commits: z.array(gitOid).max(MAX_MULTI_COMMIT_GROUPS),
      }),
    )
    .max(200),
});
export type MultiCommitUnit = z.infer<typeof multiCommitUnit>;
export type MultiCommitGroup = z.infer<typeof multiCommitGroup>;
export type MultiCommitDraft = z.infer<typeof multiCommitDraft>;
export type MultiCommitAnalysis = z.infer<typeof multiCommitAnalysis>;
export type MultiCommitDraftRequest = z.infer<typeof multiCommitDraftRequest>;
export type MultiCommitValidate = z.infer<typeof multiCommitValidate>;
export type MultiCommitPreview = z.infer<typeof multiCommitPreview>;
export type MultiCommitSubmit = z.infer<typeof multiCommitSubmit>;
export type MultiCommitReceipt = z.infer<typeof multiCommitReceipt>;
