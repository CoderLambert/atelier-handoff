/**
 * @file 打开需要操作已保存会话的桌面测试夹具。
 * @implementation 通过配对 renderer 创建测试记录，使工具验证独立于首发流程及模型服务。
 * @updated 2026-11-28T15:49:00+08:00
 */
import { z } from 'zod';
import type { Page } from 'playwright-core';

export async function openPersistedSessionFixture(page: Page) {
  const result = await page.evaluate(async () => {
    const { csrfToken, projects } = await fetch('/api/bootstrap').then((response) =>
      response.json(),
    );
    if (projects.length !== 1) throw new Error('Expected one bound fixture project');
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-atelier-token': csrfToken },
      body: JSON.stringify({ projectId: projects[0].id }),
    });
    if (!response.ok) throw new Error(`Fixture session creation failed: ${response.status}`);
    return response.json();
  });
  const { session } = z.object({ session: z.object({ id: z.uuid() }) }).parse(result);
  await page.goto(new URL(`/#/sessions/${session.id}`, page.url()).href);
  await page.locator('#prompt-input').waitFor();
  return session.id;
}
