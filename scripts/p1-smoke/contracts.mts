/**
 * @file 定义 Linux 安装验收的数据契约和通用工具。
 * @implementation 提供安装配置、原生浏览器与自动化证据类型，以及输入校验、脱敏和限时轮询。
 * @updated 2026-11-20T14:25:31+08:00
 */
import assert from 'node:assert/strict';
import { desktopBrowserAccessStateSchema } from '../../shared/desktop-browser.js';

export const browserAccess = (value: unknown) => desktopBrowserAccessStateSchema.parse(value);

export interface BrowserFixtureEvidence {
  readRequests: number;
  editRequests: number;
  calls: { name: string; input: Record<string, unknown> }[];
  initialRef: string | null;
  refreshedRef: string | null;
  clickResultReturned: boolean;
  screenshotArtifactId: string | null;
}

export interface AutomaticFixtureEvidence {
  requests: number;
  calls: { name: string; input: Record<string, unknown> }[];
  clickResultReturned: boolean;
  writeResultReturned: boolean;
  mcpResultReturned: boolean;
  mcpCalls: number;
}

export function browserSnapshot(value: unknown): {
  url: string;
  title: string;
  elements: { ref?: string; role: string; name: string }[];
} {
  const input = record(value, 'native browser snapshot');
  return {
    url: string(input.url, 'snapshot URL'),
    title: string(input.title, 'snapshot title'),
    elements: array(input.elements, 'snapshot elements').map((value) => {
      const element = record(value, 'snapshot element');
      const ref = element.ref === undefined ? undefined : string(element.ref, 'element ref');
      if (ref !== undefined) assert.match(ref, /^r[1-9]\d*-[1-9]\d*$/);
      return {
        ...(ref === undefined ? {} : { ref }),
        role: string(element.role, 'element role'),
        name: string(element.name, 'element name'),
      };
    }),
  };
}

export interface DriverConfig {
  app: string;
  launcher: string | null;
  xvfb: string;
  playwright: string;
  sourceProbe: string;
  startupMs: number;
  shutdownMs: number;
  rssMiB: number | null;
}

export interface ProcessSample {
  pid: number;
  parent: number;
  state: string;
  executable: string;
  args: string[];
  rssKiB: number;
  startTicks: string;
}

export interface LaunchEvidence {
  index: number;
  kind: 'fresh' | 'offline-reopen' | 'managed-fresh' | 'managed-reopen';
  readyMs: number | null;
  peakRssMiB: number;
  samples: number;
  processes: { pid: number; parent: number; executable: string; role: string }[];
  shutdownMs: number | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  remaining: number[];
  forced: boolean;
}

export interface AcceptanceEvidence {
  schema: 1;
  status: 'failed' | 'passed';
  phase: string;
  error?: string;
  checks: Record<string, unknown>;
  launches: LaunchEvidence[];
  metrics?: {
    freshStarts: number;
    slowestReadyMs: number;
    peakTreeRssMiB: number;
    slowestShutdownMs: number;
    rssSamplingIntervalMs: number;
    budgets: { startupMs: number; shutdownMs: number; rssMiB: number | null };
  };
}

export function record(value: unknown, label = 'object'): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `Invalid ${label}`,
  );
  return value as Record<string, unknown>;
}

export function string(value: unknown, label = 'string'): string {
  assert.equal(typeof value, 'string', `Invalid ${label}`);
  return value as string;
}

export function array(value: unknown, label = 'array'): unknown[] {
  assert.ok(Array.isArray(value), `Invalid ${label}`);
  return value;
}

export function positive(value: unknown, label: string): number {
  assert.ok(
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 300_000,
    `Invalid ${label}`,
  );
  return value;
}

export function config(value: unknown): DriverConfig {
  const input = record(value, 'driver config');
  return {
    app: string(input.app),
    launcher: input.launcher === null ? null : string(input.launcher),
    xvfb: string(input.xvfb),
    playwright: string(input.playwright),
    sourceProbe: string(input.sourceProbe),
    startupMs: positive(input.startupMs, 'startup budget'),
    shutdownMs: positive(input.shutdownMs, 'shutdown budget'),
    rssMiB: input.rssMiB === null ? null : positive(input.rssMiB, 'RSS budget'),
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redact(
  text: string,
  substitutions: readonly (readonly [string | undefined, string])[] = [],
): string {
  let result = text;
  for (const [from, to] of substitutions) if (from) result = result.split(from).join(to);
  return result
    .replace(
      /(authorization|csrfToken|x-atelier-token|api[_-]?key|auth[_-]?token)(["'\s:=]+)[^\s,"'}]+/gi,
      '$1$2<redacted>',
    )
    .replace(/\b(?:sk-ant-|sk-|Bearer )[A-Za-z0-9._-]+/g, '<redacted>');
}

export async function until<T>(
  read: () => Promise<T | undefined>,
  timeout: number,
  label: string,
): Promise<T> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
