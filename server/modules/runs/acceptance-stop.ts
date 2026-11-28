/**
 * @file 将明确交付要求的验收接入主会话 Stop 和运行终态。
 * @implementation 按真实用户输入关联 SDK 提示，限制一次纠正，把验收结果写入运行事件，并在缺少 Stop 回执时核对最终输出。
 * @updated 2026-11-28T19:30:00+08:00
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { Run } from '../../../shared/types.js';
import type { FileRecords } from '../../artifacts.js';
import type { Store } from '../../store.js';
import { checkRunAcceptance, type AcceptanceCheck } from './acceptance-check.js';
import { readAcceptanceCriteria } from './acceptance-criteria.js';

interface AcceptanceInput {
  text: string;
  messageId?: string;
  live?: { prompt: string; sdkPromptId?: string; priorArtifactIds?: ReadonlySet<string> };
  hasCriteria: boolean;
  lifetime: AbortController;
}

function acceptanceInput(text: string, messageId?: string): AcceptanceInput {
  const criteria = readAcceptanceCriteria(text);
  return {
    text,
    messageId,
    hasCriteria:
      criteria.replyOnly || criteria.exactReply !== undefined || criteria.artifacts.length > 0,
    lifetime: new AbortController(),
  };
}

export class RunAcceptanceStop {
  private current: AcceptanceInput;
  private correctionUsed = false;
  private finishing = false;
  private last?: { answer: string; artifacts: string; failure: string | null; blocked: boolean };

  constructor(
    private readonly run: Run,
    private readonly store: Store,
    private readonly files: FileRecords,
    private readonly signal: AbortSignal,
    private readonly sessionId: string,
    messageId?: string,
  ) {
    this.current = acceptanceInput(run.prompt, messageId);
  }

  get text() {
    return this.current.text;
  }

  replaceInput(text: string, messageId: string) {
    const previous = this.current;
    previous.lifetime.abort();
    const continuation = /^(?:(?:请)?继续|please continue|continue|go on)[。.!！]?$/i.test(
      text.trim(),
    );
    const addition =
      /^(?:另外|同时|此外|also\b|in addition\b|additionally\b)[\s,，:：]*(.+)$/is.exec(
        text.trim(),
      )?.[1];
    const cumulative = continuation || Boolean(addition && previous.hasCriteria);
    const requirements = continuation
      ? previous.text
      : addition && previous.hasCriteria
        ? previous.text + '\n' + addition
        : text;
    this.current = acceptanceInput(requirements, messageId);
    if (this.current.hasCriteria)
      this.current.live = {
        prompt: text,
        priorArtifactIds: cumulative
          ? previous.live?.priorArtifactIds
          : new Set(this.store.repos.artifacts.listByRun(this.run.id).map(({ id }) => id)),
      };
    this.last = undefined;
  }

  // SDK prompt_id is distinct from the user message UUID. An old Stop may arrive
  // after the host has dispatched a new input, so match the SDK's actual submission.
  private readonly onPrompt: HookCallback = async (event) => {
    if (
      event.hook_event_name === 'UserPromptSubmit' &&
      !event.agent_id &&
      event.session_id === this.sessionId &&
      this.current.live &&
      event.prompt === this.current.live.prompt
    )
      this.current.live.sdkPromptId = event.prompt_id;
    return {};
  };

  private artifactVersion() {
    return this.store.repos.artifacts
      .listByRun(this.run.id)
      .map(({ id }) => id)
      .join(',');
  }

  private async evaluate(answer: string, signal: AbortSignal, allowCorrection: boolean) {
    const current = this.current;
    const artifacts = this.artifactVersion();
    let checks: AcceptanceCheck[];
    try {
      checks = await checkRunAcceptance({
        text: current.text,
        answer,
        run: this.run,
        store: this.store,
        files: this.files,
        signal,
        priorArtifactIds: current.live?.priorArtifactIds,
      });
    } catch {
      if (signal.aborted) return;
      checks = [
        { criterion: 'verification', status: 'unverified', detail: '无法完成本轮交付验收。' },
      ];
    }
    if (signal.aborted || current !== this.current || (allowCorrection && this.finishing)) return;
    const reasons = checks.filter(({ status }) => status !== 'passed').map(({ detail }) => detail);
    const failure = reasons.length ? '交付验收未通过。' + reasons.join(' ') : null;
    // A previously published, disallowed file is immutable. Deletion cannot repair it.
    const blocked =
      allowCorrection &&
      !this.correctionUsed &&
      checks.some(
        ({ criterion, status }) =>
          status === 'failed' && criterion !== 'reply_only' && criterion !== 'only_artifacts',
      );
    const phase = this.correctionUsed ? 'recheck' : 'initial';
    if (blocked) this.correctionUsed = true;
    const result = { answer, artifacts, failure, blocked };
    this.last = result;
    if (checks.length)
      this.store.event(this.run.id, this.run.sessionId, 'run.acceptance_checked', {
        phase,
        correctionRequested: blocked,
        ...(current.messageId && { messageId: current.messageId }),
        checks,
      });
    return result;
  }

  private readonly onStop: HookCallback = async (event, _tool, options) => {
    if (
      this.finishing ||
      this.signal.aborted ||
      !this.current.hasCriteria ||
      event.hook_event_name !== 'Stop' ||
      event.agent_id ||
      event.session_id !== this.sessionId ||
      event.background_tasks?.length ||
      (this.current.live && (!event.prompt_id || this.current.live.sdkPromptId !== event.prompt_id))
    )
      return {};
    const signal = AbortSignal.any([this.signal, this.current.lifetime.signal, options.signal]);
    const checked = await this.evaluate(event.last_assistant_message ?? '', signal, true);
    if (!checked?.blocked || signal.aborted) return {};
    return {
      decision: 'block',
      reason: `${checked.failure} 请先核对已有成果，只修正未满足的要求，保留已完成的操作，遵守本轮授权。`,
    };
  };

  get hooks() {
    return { UserPromptSubmit: [{ hooks: [this.onPrompt] }], Stop: [{ hooks: [this.onStop] }] };
  }

  close() {
    this.finishing = true;
    this.current.lifetime.abort();
  }

  async finalFailure(answer: string): Promise<string | null> {
    this.close();
    if (!this.current.hasCriteria) return null;
    const previous = this.last;
    if (
      previous &&
      !previous.blocked &&
      previous.answer === answer &&
      previous.artifacts === this.artifactVersion()
    )
      return previous.failure;
    return (await this.evaluate(answer, this.signal, false))?.failure ?? null;
  }
}
