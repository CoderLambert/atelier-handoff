/**
 * @file 对运行诊断和恢复上下文中的凭据统一脱敏。
 * @implementation 清理应用已知的环境凭据及常见凭据格式，按调用边界保留或删除 URL 的非敏感诊断信息。
 * @updated 2026-11-27T16:58:55+08:00
 */
const tokenEnvironmentKeys = [
  'ATELIER_GATEWAY_TOKEN',
  'ATELIER_MAGPIE_TOKEN',
  'ATELIER_MANAGED_GATEWAY_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

function checkpointUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '[redacted URL]';
  }
}

export function redactSecrets(
  value: string,
  mode: 'diagnostic' | 'checkpoint',
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  const checkpoint = mode === 'checkpoint';
  const hidden = checkpoint ? '[redacted]' : '[已隐藏]';
  const key = checkpoint ? '[redacted key]' : hidden;
  const token = checkpoint ? '[redacted token]' : hidden;
  // Scrub multiline secrets before parsing URL-shaped text inside them.
  let safe = value.replace(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
    key,
  );
  // Read values at call time and match longer overlapping values first.
  const configuredTokens = tokenEnvironmentKeys
    .map((name) => env[name])
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length);
  for (const secret of configuredTokens) safe = safe.replaceAll(secret, () => hidden);
  if (checkpoint) {
    safe = safe
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/https?:\/\/[^\s<>"']+/gi, checkpointUrl);
  } else {
    safe = safe
      .replace(/(https?:\/\/)[^\s/@]+@/gi, `$1${hidden}@`)
      .replace(/([?&](?:token|key|api_key|access_token)=)[^&\s]+/gi, `$1${hidden}`);
  }
  safe = safe
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|authorization)\s*["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?:Bearer|Basic)\s+[^\s,"';]+|["']?[^\s,"';<>&]+)/gi,
      `$1${hidden}`,
    )
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, `$1 ${hidden}`)
    .replace(/\b(?:sk-|sk_ant_)[A-Za-z0-9_-]{8,}/g, token)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, token)
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, key);

  return safe;
}
