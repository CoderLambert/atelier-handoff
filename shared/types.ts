export type RunStatus = 'queued' | 'running' | 'awaiting_permission' | 'stopping' | 'completed' | 'stopped' | 'failed' | 'interrupted';
export type Mode = 'readonly' | 'edit';
export const activeStatuses: RunStatus[] = ['queued', 'running', 'awaiting_permission', 'stopping'];
export interface Project { id: string; name: string; path: string; branch: string; available: boolean; createdAt: string }
export interface Draft { text: string; contextPaths: string[]; attachmentIds: string[]; mode: Mode }
export interface Session { id: string; projectId: string; title: string; status: 'active' | 'archived'; sdkSessionId: string | null; sdkCostTotal?: number; sdkMode?: Mode; sdkConfigKey?: string; createdAt: string; updatedAt: string; draft: Draft }
export interface Step { content: string; status: 'pending' | 'in_progress' | 'completed' }
export interface Usage { model: string; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheCreationTokens: number | null; sdkEstimateUsd: number | null; costEstimateUsd: null; pricingBasis: 'unknown'; complete: boolean }
export interface Run { id: string; sessionId: string; projectId: string; prompt: string; status: RunStatus; mode: Mode; createdAt: string; startedAt: string | null; endedAt: string | null; reason: string | null; error: string | null; retryOf: string | null; contextPaths: string[]; attachmentIds: string[]; plan: Step[]; usage: Usage | null; config: AppConfig }
export interface Message { id: string; sessionId: string; runId: string; role: 'user' | 'assistant'; text: string; createdAt: string }
export interface ToolCall { id: string; runId: string; sessionId: string; name: string; inputSummary: string; status: 'running' | 'awaiting_permission' | 'succeeded' | 'failed' | 'denied' | 'canceled'; output: string; outputLength?: number; outputTruncated?: boolean; startedAt: string; endedAt: string | null; permissionId?: string }
export interface Permission { id: string; runId: string; sessionId: string; toolCallId: string; kind: 'write' | 'edit' | 'delete' | 'command'; path: string | null; command: string | null; before: string | null; after: string | null; diff: string; baseFingerprint: string | null; version: string; status: 'pending' | 'allowed' | 'denied' | 'expired' | 'canceled'; createdAt: string; expiresAt: string; reason: string; resolutionReason?: string }
export interface Artifact { id: string; runId: string; sessionId: string; projectId: string; name: string; mime: string; size: number; fingerprint: string; availability: 'available' | 'unavailable'; createdAt: string }
export interface Attachment { id: string; sessionId: string; name: string; mime: string; size: number; status: 'ready' | 'used'; createdAt: string; removed?: boolean }
export interface RunEvent { id: number; runId: string; sessionId: string; seq: number; type: string; at: string; payload: Record<string, unknown> }
export interface AppConfig { gateway: string; model: string; maxTurns: number; timeoutMs: number }
export interface Tables { projects: Project; sessions: Session; runs: Run; messages: Message; tools: ToolCall; permissions: Permission; artifacts: Artifact; attachments: Attachment }
export type Table = keyof Tables;
export class AppError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly retryable = false) { super(message); }
}
export const now = () => new Date().toISOString();
export const emptyDraft = (): Draft => ({ text: '', contextPaths: [], attachmentIds: [], mode: 'readonly' });
