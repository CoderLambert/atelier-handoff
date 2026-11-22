/**
 * @file 从旧会话的原生 SDK 对话中核对消息切点。
 * @implementation 使用唯一的完整问答对应关系恢复切点，验证工具调用与结果的边界。
 * @updated 2026-11-21T16:59:00+08:00
 */
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Message, Run, Session } from '../shared/types.js';
import { legacyForkTurnSchema } from './session-fork-sdk-protocol.js';

const promptMarker = '\n\n用户本轮任务：\n';
const contentBlock = z.object({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  tool_use_id: z.string().optional(),
});
const nativeBody = z.object({ content: z.union([z.string(), z.array(contentBlock)]) });
const uuid = z.uuid();
type LegacyForkTurn = z.infer<typeof legacyForkTurnSchema>;

export function transcriptForkTurns(
  sdkSessionId: string,
  messages: SessionMessage[],
): LegacyForkTurn[] {
  const turns: LegacyForkTurn[] = [];
  const pendingTools = new Set<string>();
  const seen = new Set<string>();
  let turn: { prompt: string; userId: string; reply: string[]; assistantId?: string } | undefined;
  const finishTurn = () => {
    if (turn?.assistantId && pendingTools.size === 0) {
      turns.push({
        sdkSessionId,
        prompt: turn.prompt,
        reply: turn.reply.join('\n\n'),
        userId: turn.userId,
        assistantId: turn.assistantId,
      });
    }
    turn = undefined;
  };
  for (const message of messages) {
    if (
      message.session_id !== sdkSessionId ||
      message.parent_tool_use_id ||
      message.parent_agent_id ||
      message.type === 'system'
    )
      continue;
    const data = nativeBody.safeParse(message.message);
    if (!data.success || !uuid.safeParse(message.uuid).success || seen.has(message.uuid)) return [];
    seen.add(message.uuid);
    const content = data.data.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (message.type === 'user') {
      if (blocks.some(({ type }) => type === 'tool_result')) {
        for (const block of blocks) {
          if (block.type === 'tool_result' && 'tool_use_id' in block && block.tool_use_id)
            pendingTools.delete(block.tool_use_id);
        }
        continue;
      }
      finishTurn();
      const prompt = blocks.find(({ type }) => type === 'text')?.text ?? '';
      const marker = prompt.indexOf(promptMarker);
      if (
        marker >= 0 &&
        pendingTools.size === 0 &&
        blocks.every(({ type }) => type === 'text' || type === 'image')
      ) {
        turn = {
          prompt: prompt.slice(marker + promptMarker.length),
          userId: message.uuid,
          reply: [],
        };
      }
      continue;
    }
    let containsTool = false;
    let hasText = false;
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        if (!('id' in block) || !block.id) return [];
        containsTool = true;
        pendingTools.add(block.id);
      }
      if (block.type === 'text' && block.text && turn) {
        turn.reply.push(block.text);
        hasText = true;
      }
    }
    if (turn)
      turn.assistantId =
        hasText && !containsTool && pendingTools.size === 0 ? message.uuid : undefined;
  }
  finishTurn();
  return turns;
}

export function matchLegacyForkAnchors(
  session: Session,
  runs: Run[],
  messages: Message[],
  transcript: LegacyForkTurn[],
): { id: string; anchor: NonNullable<Message['forkAnchor']> }[] {
  const paired = new Map<string, Message[]>();
  for (const message of messages) {
    const entries = paired.get(message.runId) ?? [];
    entries.push(message);
    paired.set(message.runId, entries);
  }
  const appTurns = new Map<string, { run: Run; user: Message; assistant: Message }[]>();
  for (const run of runs) {
    const [user, assistant, ...rest] = paired.get(run.id) ?? [];
    if (
      rest.length ||
      user?.role !== 'user' ||
      assistant?.role !== 'assistant' ||
      user.text !== run.prompt ||
      !assistant.text.trim()
    )
      continue;
    const matches = appTurns.get(assistant.text) ?? [];
    matches.push({ run, user, assistant });
    appTurns.set(assistant.text, matches);
  }
  const candidates = transcript.map((turn) => ({
    turn,
    matches: (appTurns.get(turn.reply) ?? []).filter(({ run, user }) =>
      matchesLegacyPrompt(run, user.text, turn.prompt),
    ),
  }));
  const matchCounts = new Map<string, number>();
  for (const { matches } of candidates)
    for (const { run } of matches) matchCounts.set(run.id, (matchCounts.get(run.id) ?? 0) + 1);

  return candidates.flatMap(({ turn, matches }) => {
    const entry = matches[0];
    if (
      matches.length !== 1 ||
      !entry ||
      entry.run.status !== 'completed' ||
      matchCounts.get(entry.run.id) !== 1
    )
      return [];
    const configKey = turn.sdkSessionId === session.sdkSessionId ? session.sdkConfigKey : undefined;
    const anchors = [
      { message: entry.user, messageId: turn.userId },
      { message: entry.assistant, messageId: turn.assistantId },
    ];
    return anchors
      .filter(({ message }) => !message.forkAnchor)
      .map(({ message, messageId }) => ({
        id: message.id,
        anchor: { sdkSessionId: turn.sdkSessionId, messageId, configKey },
      }));
  });
}

function matchesLegacyPrompt(run: Run, text: string, nativePrompt: string): boolean {
  if (nativePrompt === text) return true;
  const extension = run.extensions?.find(({ kind }) => kind === 'skill' || kind === 'command');
  if (!extension) return false;
  const header = `扩展 ${extension.name}（${extension.kind}）说明：\n`;
  const request = `\n\n本轮用户要求：\n${text}`;
  return (
    nativePrompt.length >= header.length + request.length &&
    nativePrompt.startsWith(header) &&
    nativePrompt.endsWith(request)
  );
}
