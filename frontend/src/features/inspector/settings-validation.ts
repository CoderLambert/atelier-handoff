/**
 * @file 提供模型与执行设置的纯草稿校验及网关地址规范化函数。
 * @implementation 复用单一规则校验外部 localhost 网关 URL、非空白模型名及受限执行的回合与超时整数范围。
 * @updated 2026-11-27T22:20:00+08:00
 */

export type SettingsValidationField = 'gateway' | 'model' | 'turns' | 'timeout';

export type SettingsValidationMessageKey =
  | 'settings.invalidGateway'
  | 'settings.invalidGatewayAddress'
  | 'settings.invalidModel'
  | 'settings.invalidTurns'
  | 'settings.invalidTimeout';

export interface SettingsValidationError {
  readonly field: SettingsValidationField;
  readonly messageKey: SettingsValidationMessageKey;
}

export type SettingsDraftValidationResult =
  | {
      readonly ok: true;
      readonly turns: number;
      readonly timeout: number;
      readonly validTurns: boolean;
      readonly validTimeout: boolean;
    }
  | {
      readonly ok: false;
      readonly error: SettingsValidationError;
    };

export function normalizeGatewayUrl(value: string): string {
  return value.trim().replace(/\/$/u, '');
}

export function validateSettingsDraft(input: {
  usingBundled: boolean;
  gateway: string;
  model: string;
  limitExecution: boolean;
  maxTurns: string;
  timeoutMs: string;
}): SettingsDraftValidationResult {
  if (!input.usingBundled) {
    let url: URL;
    try {
      url = new URL(input.gateway.trim());
    } catch {
      return { ok: false, error: { field: 'gateway', messageKey: 'settings.invalidGateway' } };
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return {
        ok: false,
        error: { field: 'gateway', messageKey: 'settings.invalidGatewayAddress' },
      };
    }
  }

  const trimmedModel = input.model.trim();
  if (trimmedModel.length > 200 || !/^\S+$/u.test(trimmedModel)) {
    return { ok: false, error: { field: 'model', messageKey: 'settings.invalidModel' } };
  }

  const turns = Number(input.maxTurns);
  const timeout = Number(input.timeoutMs);
  const validTurns = Number.isInteger(turns) && turns >= 1 && turns <= 100;
  const validTimeout = Number.isInteger(timeout) && timeout >= 10000 && timeout <= 1800000;

  if (input.limitExecution && !validTurns) {
    return { ok: false, error: { field: 'turns', messageKey: 'settings.invalidTurns' } };
  }
  if (input.limitExecution && !validTimeout) {
    return { ok: false, error: { field: 'timeout', messageKey: 'settings.invalidTimeout' } };
  }

  return { ok: true, turns, timeout, validTurns, validTimeout };
}
