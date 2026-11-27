/**
 * @file 构建单任务远程触发端点路径与 curl 调用示例。
 * @implementation 纯函数拼装触发地址与示例命令，避免在 JSX 组件中硬编码协议字符串。
 * @updated 2026-11-27T15:30:00+08:00
 */
export function buildScheduleTriggerEndpoint(targetRef: string): string {
  return `/api/triggers/schedules/${encodeURIComponent(targetRef)}`;
}

export function buildScheduleTriggerEndpointLabel(targetRef: string): string {
  return `POST ${buildScheduleTriggerEndpoint(targetRef)}`;
}

export function buildScheduleTriggerCurl(
  origin: string,
  targetRef: string,
  token: string | null,
  sampleInput: string,
): string {
  const endpoint = buildScheduleTriggerEndpoint(targetRef);
  const auth = token ?? '<YOUR_TRIGGER_TOKEN>';
  const payload = JSON.stringify({ input: sampleInput });
  return [
    `curl -X POST "${origin}${endpoint}" \\`,
    `  -H "Authorization: Bearer ${auth}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${payload}'`,
  ].join('\n');
}
