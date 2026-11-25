/**
 * @file 为子代理插话回归提供隔离的回环模型。
 * @implementation 分别控制两个模型分支的响应，记录主会话收到的指令和报告。
 * @updated 2026-11-25T23:48:00+08:00
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { sendModelReply } from './subagent-gateway.js';

export function subagentInsertionFixture(project: string) {
  const model = 'fixture-subagent-insertion';
  const initial = 'START_SUBAGENT_INSERTION';
  const steer = 'STEER_WHILE_CHILDREN_WORK';
  const ordinary = 'QUEUE_WHILE_CHILDREN_WORK';
  const acknowledgement = 'The parent received the new direction.';
  const queuedAcknowledgement = 'The parent received the queued message.';
  const collected = 'The parent collected the child reports.';
  const sampleText = 'CHECKED_BACKGROUND_TOOL_OWNER';
  const sampleName = 'subagent-fixture.txt';
  const errors: unknown[] = [];
  const parentInputs: string[] = [];
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
    };
  });
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
          sendModelReply(response, model, child.report);
        } else {
          child.started = true;
          await child.gate;
          if (response.destroyed) return;
          sendModelReply(response, model, [
            { name: 'Read', id: child.readId, input: { file_path: join(project, sampleName) } },
          ]);
        }
        return;
      }

      assert.ok(text.includes(initial));
      parentInputs.push(text);
      if (children.every(({ report }) => text.includes(report))) {
        sendModelReply(response, model, collected);
      } else if (text.includes(ordinary)) {
        sendModelReply(response, model, queuedAcknowledgement);
      } else if (text.includes(steer)) {
        sendModelReply(response, model, acknowledgement);
      } else if (children.some(({ spawnId }) => text.includes(spawnId))) {
        sendModelReply(response, model, 'Waiting for the child reports.');
      } else {
        sendModelReply(
          response,
          model,
          children.map(({ spawnId: id, title: description, prompt }) => ({
            name: 'Agent',
            id,
            input: {
              description,
              prompt,
              subagent_type: 'atelier-explore',
              run_in_background: false,
            },
          })),
        );
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
    sampleText,
    sampleName,
    errors,
    children,
    parentInputs,
  };
}
