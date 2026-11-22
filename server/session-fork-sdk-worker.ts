/**
 * @file 在隔离配置目录内调用原生 SDK 会话分支 API。
 * @implementation 仅执行本地 forkSession，不启动 query 或模型；输入、结果和错误通过已校验的线程消息交接。
 * @updated 2026-11-21T22:00:00+08:00
 */
import { forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { parentPort, workerData } from 'node:worker_threads';
import { transcriptForkTurns } from './session-fork-legacy.js';
import {
  legacyForkReplySchema,
  sessionForkJobSchema,
  sessionForkReplySchema,
} from './session-fork-sdk-protocol.js';

if (!parentPort) throw new Error('Session fork helper requires a worker port.');
try {
  const job = sessionForkJobSchema.parse(workerData as unknown);
  if (job.kind === 'read') {
    const turns = [];
    for (const id of job.sourceSessionIds) {
      const history = await getSessionMessages(id, { dir: job.projectPath });
      turns.push(...transcriptForkTurns(id, history));
    }
    parentPort.postMessage(legacyForkReplySchema.parse({ ok: true, turns }));
  } else {
    const result = await forkSession(job.sourceSessionId, {
      dir: job.projectPath,
      upToMessageId: job.upToMessageId,
      title: job.title,
    });
    parentPort.postMessage(sessionForkReplySchema.parse({ ok: true, sessionId: result.sessionId }));
  }
} catch (error) {
  parentPort.postMessage(
    sessionForkReplySchema.parse({
      ok: false,
      message: error instanceof Error ? error.message : 'Native SDK session fork failed.',
    }),
  );
}
