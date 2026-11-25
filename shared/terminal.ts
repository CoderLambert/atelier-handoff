/**
 * @file 定义人工终端的生命周期、传输与限额契约。
 * @implementation HTTP 与 WebSocket 共用严格 schema；按 UTF-8 和完整 JSON 大小切分输入，身份包含 runtime 与 attachment 代次。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { z } from 'zod';

export const terminalProtocol = 'atelier-terminal.v1';
export const terminalStreamPath = '/api/terminals/stream';
export const terminalLimits = {
  perRuntime: 8,
  perSession: 4,
  ledger: 4096,
  scrollback: 2000,
  minCols: 2,
  maxCols: 400,
  minRows: 1,
  maxRows: 200,
  inputBytes: 64 * 1024,
  frameBytes: 128 * 1024,
  outputChunkBytes: 32 * 1024,
  outputWindowBytes: 512 * 1024,
  liveBufferBytes: 1024 * 1024,
  snapshotBytes: 8 * 1024 * 1024,
  snapshotBufferBytes: 8 * 1024 * 1024 + 64 * 1024,
  screenHighBytes: 256 * 1024,
  screenLowBytes: 64 * 1024,
  screenHardBytes: 4 * 1024 * 1024,
  ticketTtlMs: 30_000,
  firstReadyMs: 30_000,
  snapshotTimeoutMs: 10_000,
  heartbeatMs: 15_000,
  heartbeatTimeoutMs: 30_000,
  closeTimeoutMs: 6_000,
} as const;

const uuid = z.uuid();
const sequence = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSequence = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const cols = z.int().min(terminalLimits.minCols).max(terminalLimits.maxCols);
const rows = z.int().min(terminalLimits.minRows).max(terminalLimits.maxRows);
const encoder = new TextEncoder();
export const terminalStateSchema = z.enum([
  'creating',
  'awaiting-attach',
  'starting',
  'running',
  'exited',
  'closing',
  'cleanup-failed',
  'closed',
  'failed',
]);
export type TerminalState = z.infer<typeof terminalStateSchema>;

export const terminalRecordSchema = z.strictObject({
  runtimeId: uuid,
  terminalId: uuid,
  sessionId: uuid,
  projectId: uuid,
  workspaceId: uuid.nullable(),
  initialCwd: z.string().max(4096),
  shellName: z.string().max(128),
  cols,
  rows,
  state: terminalStateSchema,
  createdAt: z.iso.datetime(),
  exitCode: z.int().nullable(),
  exitSignal: z.int().nullable(),
  errorCode: z.string().max(80).optional(),
});
export type TerminalRecord = z.infer<typeof terminalRecordSchema>;
export const terminalRuntimeRequestSchema = z.strictObject({ runtimeId: uuid });
export const terminalCreateRequestSchema = terminalRuntimeRequestSchema.extend({
  terminalId: uuid,
  expectedWorkspaceId: uuid.nullable(),
  cols,
  rows,
});
export type TerminalCreateRequest = z.infer<typeof terminalCreateRequestSchema>;
export const terminalCapabilitiesSchema = z.strictObject({
  supported: z.boolean(),
  reason: z.enum([
    'available',
    'desktop-required',
    'platform-unsupported',
    'native-execution-disabled',
    'runtime-unavailable',
  ]),
  runtimeId: uuid,
  shellName: z.string().max(128).nullable(),
  protocolVersion: z.literal(1),
  limits: z.strictObject({ perRuntime: z.int().positive(), perSession: z.int().positive() }),
});
export type TerminalCapabilities = z.infer<typeof terminalCapabilitiesSchema>;
export const terminalListResponseSchema = z.strictObject({
  runtimeId: uuid,
  terminals: z.array(terminalRecordSchema).max(terminalLimits.perSession),
});
export type TerminalListResponse = z.infer<typeof terminalListResponseSchema>;
export const terminalCreateResponseSchema = z.strictObject({ terminal: terminalRecordSchema });
export const terminalCloseResponseSchema = z.strictObject({
  runtimeId: uuid,
  terminalId: uuid,
  state: z.enum(['closed', 'closing', 'cleanup-failed']),
});
export type TerminalCloseResponse = z.infer<typeof terminalCloseResponseSchema>;
export const terminalTicketResponseSchema = z.strictObject({
  runtimeId: uuid,
  ticket: z.string().regex(/^[a-f0-9]{64}$/u),
  expiresAt: z.iso.datetime(),
  streamPath: z.literal(terminalStreamPath),
  protocol: z.literal(terminalProtocol),
});
export type TerminalTicketResponse = z.infer<typeof terminalTicketResponseSchema>;

export const terminalInputPayloadSchema = z.discriminatedUnion('encoding', [
  z.strictObject({
    encoding: z.literal('utf8'),
    data: z
      .string()
      .min(1)
      .max(terminalLimits.inputBytes)
      .refine((value) => encoder.encode(value).byteLength <= terminalLimits.inputBytes),
  }),
  z.strictObject({
    encoding: z.literal('binary'),
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(terminalLimits.inputBytes / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
      .refine(
        (value) =>
          (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) <=
          terminalLimits.inputBytes,
      ),
  }),
]);
export type TerminalInputPayload = z.infer<typeof terminalInputPayloadSchema>;
export const terminalClientFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), attachmentId: uuid, seq: sequence }),
  z.strictObject({ type: z.literal('outputAck'), attachmentId: uuid, seq: sequence }),
  z.strictObject({
    type: z.literal('input'),
    attachmentId: uuid,
    inputSeq: positiveSequence,
    payload: terminalInputPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('resize'),
    attachmentId: uuid,
    commandSeq: positiveSequence,
    cols,
    rows,
  }),
]);
export type TerminalClientFrame = z.infer<typeof terminalClientFrameSchema>;
export type TerminalInputFrame = Extract<TerminalClientFrame, { type: 'input' }>;

export const terminalServerFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('snapshot'),
    attachmentId: uuid,
    seq: sequence,
    screen: z.string().max(terminalLimits.snapshotBytes),
    terminal: terminalRecordSchema,
  }),
  z.strictObject({
    type: z.literal('output'),
    attachmentId: uuid,
    seq: sequence,
    data: z.string().max(terminalLimits.frameBytes),
  }),
  z.strictObject({ type: z.literal('resized'), attachmentId: uuid, seq: sequence, cols, rows }),
  z.strictObject({
    type: z.literal('state'),
    attachmentId: uuid,
    seq: sequence,
    terminal: terminalRecordSchema,
  }),
  z.strictObject({
    type: z.literal('readyAccepted'),
    attachmentId: uuid,
    writable: z.boolean(),
    terminal: terminalRecordSchema,
  }),
  z.strictObject({
    type: z.literal('inputAccepted'),
    attachmentId: uuid,
    inputSeq: positiveSequence,
  }),
  z.strictObject({
    type: z.literal('commandResult'),
    attachmentId: uuid,
    commandSeq: positiveSequence,
    ok: z.boolean(),
  }),
  z.strictObject({ type: z.literal('error'), attachmentId: uuid, code: z.string().min(1).max(80) }),
]);
export type TerminalServerFrame = z.infer<typeof terminalServerFrameSchema>;

export function terminalHasActiveProcess(state: TerminalState): boolean {
  return [
    'creating',
    'awaiting-attach',
    'starting',
    'running',
    'closing',
    'cleanup-failed',
  ].includes(state);
}

/** Split before UTF-8/JSON budgets; a surrogate pair always stays in one frame. */
export function splitTerminalInput(
  data: string,
  attachmentId: string,
  firstSequence: number,
): Array<TerminalInputFrame & { payload: { encoding: 'utf8'; data: string } }> {
  const frames: Array<TerminalInputFrame & { payload: { encoding: 'utf8'; data: string } }> = [];
  let current = '';
  let bytes = 0;
  let escapedBytes = 0;
  const flush = () => {
    if (!current) return;
    frames.push({
      type: 'input',
      attachmentId,
      inputSeq: firstSequence + frames.length,
      payload: { encoding: 'utf8', data: current },
    });
    current = '';
    bytes = 0;
    escapedBytes = 0;
  };
  // The fixed identity/sequence envelope fits in 256 bytes even at MAX_SAFE_INTEGER.
  for (const point of data) {
    const length = encoder.encode(point).byteLength;
    const escaped = encoder.encode(JSON.stringify(point)).byteLength - 2;
    if (
      bytes + length > terminalLimits.inputBytes ||
      escapedBytes + escaped > terminalLimits.frameBytes - 256
    )
      flush();
    current += point;
    bytes += length;
    escapedBytes += escaped;
  }
  flush();
  return frames;
}
