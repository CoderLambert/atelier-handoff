/**
 * @file 根据明确的用户要求核对本轮回复和不可变交付物。
 * @implementation 在发布前核对用户限定的交付范围，从最新原件、指纹与最终回复验证文件、指定原文和 HTML 条件。
 * @updated 2026-11-28T19:47:32+08:00
 */
import { AppError } from '../../../shared/errors.js';
import type { AcceptanceCheck } from '../../../shared/run-acceptance.js';
import type { Run } from '../../../shared/types.js';
import type { FileRecords } from '../../artifacts.js';
import type { Store } from '../../store.js';
import { readAcceptanceCriteria } from './acceptance-criteria.js';

export type { AcceptanceCheck } from '../../../shared/run-acceptance.js';

export function assertAcceptancePublication(text: string, name: string) {
  const criteria = readAcceptanceCriteria(text);
  if (criteria.replyOnly)
    throw new AppError('REPLY_ONLY', '用户要求仅在回复中交付。请将结果写入回复。', 409);
  if (criteria.onlyArtifacts && !criteria.artifacts.includes(name))
    throw new AppError('ARTIFACT_OUT_OF_SCOPE', '此文件不在用户指定的交付清单中。', 409);
}

export async function checkRunAcceptance({
  text,
  answer,
  priorArtifactIds,
  run,
  store,
  files,
  signal,
}: {
  text: string;
  answer: string;
  priorArtifactIds?: ReadonlySet<string>;
  run: Run;
  store: Store;
  files: FileRecords;
  signal: AbortSignal;
}): Promise<AcceptanceCheck[]> {
  signal.throwIfAborted();
  const criteria = readAcceptanceCriteria(text);
  const checks: AcceptanceCheck[] = [];
  if (criteria.exactReply !== undefined) {
    const matches = answer.trim() === criteria.exactReply;
    checks.push({
      criterion: 'exact_reply',
      status: matches ? 'passed' : 'failed',
      detail: matches ? '回复与指定文字一致。' : '最终回复与用户指定的完整文字不一致。',
    });
  }
  if (criteria.replyOnly && criteria.exactReply === undefined)
    checks.push({
      criterion: 'reply_present',
      status: answer.trim() ? 'passed' : 'failed',
      detail: answer.trim() ? '最终回复含有文字。' : '用户要求文字回复，最终回复为空。',
    });
  if (!criteria.artifacts.length && !criteria.replyOnly) return checks;
  const artifacts = store.repos.artifacts.listByRun(run.id);
  const newArtifacts = priorArtifactIds
    ? artifacts.filter(({ id }) => !priorArtifactIds.has(id))
    : artifacts;
  if (criteria.onlyArtifacts) {
    const extra = newArtifacts.filter(({ name }) => !criteria.artifacts.includes(name));
    checks.push({
      criterion: 'only_artifacts',
      status: extra.length ? 'failed' : 'passed',
      detail: extra.length
        ? '已发布未要求的成果：' + extra.map(({ name }) => name).join('、')
        : '已发布的成果均在指定清单内。',
    });
  }
  if (criteria.replyOnly)
    checks.push({
      criterion: 'reply_only',
      status: newArtifacts.length ? 'failed' : 'passed',
      detail: `本轮已发布 ${newArtifacts.length} 个文件，用户要求仅回复。`,
    });
  for (const name of criteria.artifacts) {
    signal.throwIfAborted();
    // The repository returns insertion order. A correction must verify the newest bytes.
    const artifact = artifacts.findLast((item) => item.name === name);
    if (!artifact) {
      checks.push({
        criterion: 'published_artifact',
        status: 'failed',
        detail: `缺少本轮可下载的成果 ${name}。`,
      });
      continue;
    }
    const identity = { artifactId: artifact.id, fingerprint: artifact.fingerprint };
    let bytes: Buffer;
    try {
      ({ bytes } = await files.content(artifact.id));
    } catch {
      checks.push({
        criterion: 'published_artifact',
        status: 'unverified',
        detail: `无法读取并核对 ${name} 的原件。`,
        ...identity,
      });
      continue;
    }
    checks.push({
      criterion: 'published_artifact',
      status: bytes.length ? 'passed' : 'failed',
      detail: `${name} 实际读取 ${bytes.length} 字节。`,
      ...identity,
    });
    const passages = criteria.requiredPassages?.filter((passage) => passage.name === name);
    if (passages?.length) {
      let original: string | undefined;
      try {
        original = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        // A failed decode cannot establish presence or absence in the original text.
      }
      for (const passage of passages) {
        const found = original?.includes(passage.text);
        checks.push({
          criterion: 'artifact_contains',
          status: found === undefined ? 'unverified' : found ? 'passed' : 'failed',
          detail:
            found === undefined
              ? `${name} 无法作为 UTF-8 文本核验。`
              : `${name} ${found ? '包含' : '缺少'}用户要求的原文「${passage.text}」。`,
          ...identity,
        });
      }
    }
    if (bytes.length && criteria.html?.name === name) {
      try {
        const { verifyAcceptanceHtml } = await import('./html-acceptance.js');
        const observations = await verifyAcceptanceHtml(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
          criteria.html,
          signal,
        );
        if (!observations.length) throw new Error('Missing HTML observations');
        checks.push(...observations.map((check) => ({ ...check, ...identity })));
      } catch {
        signal.throwIfAborted();
        checks.push({
          criterion: 'html_verification',
          status: 'unverified',
          detail: `无法执行 ${name} 的 HTML 实测。`,
          ...identity,
        });
      }
    }
  }
  signal.throwIfAborted();
  return checks;
}
