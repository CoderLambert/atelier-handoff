/**
 * @file 为子代理插话回归提供隔离的回环模型。
 * @implementation 控制前后台分支、插话回复和报告汇总的等待时机，记录主会话收到的指令与报告。
 * @updated 2026-11-26T23:08:48+08:00
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { sendModelReply } from './subagent-gateway.js';

export function subagentInsertionFixture(
  project: string,
  scenario: 'foreground' | 'steered' | 'native-background' | 'hold-reply' = 'foreground',
) {
  const model = 'fixture-subagent-insertion';
  const initial = 'START_SUBAGENT_INSERTION';
  const steer = 'STEER_WHILE_CHILDREN_WORK';
  const ordinary = 'QUEUE_WHILE_CHILDREN_WORK';
  const acknowledgement = 'The parent received the new direction.';
  const queuedAcknowledgement = 'The parent received the queued message.';
  const collected = 'The parent collected the child reports.';
  const duringCollection = 'STEER_DURING_REPORT_COLLECTION';
  const collectionAcknowledgement = 'The parent received the instruction during report collection.';
  const waiting = 'Waiting for the child reports.';
  const sampleText = 'CHECKED_BACKGROUND_TOOL_OWNER';
  const sampleName = 'subagent-fixture.txt';
  const errors: unknown[] = [];
  const parentInputs: string[] = [];
  let sawParentRequest = () => {};
  const parentStarted = new Promise<void>((resolve) => {
    sawParentRequest = resolve;
  });
  const children = ['ALPHA', 'BETA'].map((name, index) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      prompt: 'INSERTION_CHILD_' + name,
      title: 'Inspect fixture ' + name,
      report: 'INSPECTION_REPORT_' + name,
      spawnId: 'toolu_insertion_spawn_' + index,
      readId: 'toolu_insertion_read_' + index,
      gate,
      release,
      started: false,
      readReturned: false,
    };
  });
  let releaseInitial = () => {};
  const initialGate = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  let releaseReply = () => {};
  const replyGate = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  let releaseCollection = () => {};
  const collectionGate = new Promise<void>((resolve) => {
    releaseCollection = resolve;
  });
  let startCollection = () => {};
  const collectionStarted = new Promise<void>((resolve) => {
    startCollection = resolve;
  });
  const dispatch = children.map(({ spawnId: id, title: description, prompt }, index) => ({
    name: 'Agent',
    id,
    input: {
      description,
      prompt,
      subagent_type: 'atelier-explore',
      ...(scenario === 'native-background'
        ? index === 0
          ? {}
          : { run_in_background: true }
        : { run_in_background: false }),
    },
  }));
  const gateway = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ model, id: model }] }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const text = JSON.stringify(body.messages);
      const child = !text.includes(initial)
        ? children.find(({ prompt }) => text.includes(prompt))
        : undefined;
      if (child) {
        if (text.includes(child.readId)) {
          assert.ok(text.includes(sampleText), 'The background subagent must retain its Read tool');
          child.readReturned = true;
          if (scenario === 'steered') await child.gate;
          if (response.destroyed) return;
          sendModelReply(response, model, child.report);
        } else {
          child.started = true;
          if (scenario !== 'steered') await child.gate;
          if (response.destroyed) return;
          sendModelReply(response, model, [
            { name: 'Read', id: child.readId, input: { file_path: join(project, sampleName) } },
          ]);
        }
        return;
      }

      assert.ok(text.includes(initial));
      parentInputs.push(text);
      sawParentRequest();
      if (children.every(({ report }) => text.includes(report))) {
        startCollection();
        if (scenario === 'steered' && !text.includes(duringCollection)) await collectionGate;
        if (!response.destroyed)
          sendModelReply(
            response,
            model,
            text.includes(duringCollection) ? [collected, collectionAcknowledgement] : collected,
          );
      } else if (text.includes(ordinary)) {
        sendModelReply(response, model, queuedAcknowledgement);
      } else if (text.includes(steer)) {
        if (scenario === 'hold-reply') await replyGate;
        if (response.destroyed) return;
        sendModelReply(
          response,
          model,
          scenario === 'steered' && !children.some(({ spawnId }) => text.includes(spawnId))
            ? [acknowledgement, ...dispatch]
            : acknowledgement,
        );
      } else if (children.some(({ spawnId }) => text.includes(spawnId))) {
        sendModelReply(response, model, waiting);
      } else if (scenario === 'steered' || scenario === 'hold-reply') {
        await initialGate;
        if (!response.destroyed) sendModelReply(response, model, 'Initial model request finished.');
      } else {
        sendModelReply(response, model, dispatch);
      }
    } catch (error) {
      errors.push(error);
      response.writeHead(400).end();
    }
  });
  return {
    gateway,
    model,
    initial,
    steer,
    ordinary,
    acknowledgement,
    queuedAcknowledgement,
    collected,
    duringCollection,
    collectionAcknowledgement,
    collectionStarted,
    releaseCollection,
    waiting,
    releaseInitial,
    releaseReply,
    sampleText,
    sampleName,
    errors,
    children,
    parentInputs,
    parentStarted,
  };
}
