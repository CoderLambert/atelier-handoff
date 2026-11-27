/**
 * @file 基于共享扩展契约的前端表单校验与错误消息映射。
 * @implementation 调用 validateExtensionInput 并将结构化错误码翻译为当前界面语言，同时解析 stdio JSON 参数数组。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { getTranslator } from '@/i18n';
import {
  validateExtensionInput,
  type ExtensionInput,
  type ExtensionValidationCode,
} from '@shared/extensions';

const validationMessageKeys = {
  invalid_name: 'extensionEditor.invalidName',
  description_too_long: 'extensionEditor.descriptionTooLong',
  source_too_long: 'extensionEditor.sourceTooLong',
  body_required: 'extensionEditor.bodyRequired',
  body_too_long: 'extensionEditor.bodyTooLong',
  invalid_url: 'extensionEditor.invalidUrl',
  unsafe_url: 'extensionEditor.unsafeUrl',
  invalid_token_env: 'extensionEditor.invalidToken',
  invalid_env_name: 'extensionEditor.invalidEnv',
  too_many_env_names: 'extensionEditor.tooManyEnvNames',
  invalid_command: 'extensionEditor.commandRequired',
  invalid_args: 'extensionEditor.invalidArgs',
  too_many_args: 'extensionEditor.tooManyArgs',
  invalid_input: 'extensionEditor.invalidInput',
} as const satisfies Record<ExtensionValidationCode, string>;

export function parseJsonStringArray(value: string): string[] {
  const t = getTranslator('extensions');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '[]');
  } catch {
    throw new Error(t('extensionEditor.invalidArgs'));
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(t('extensionEditor.invalidArgs'));
  }
  return parsed;
}

export function parseExtensionPayload(raw: unknown): ExtensionInput {
  const result = validateExtensionInput(raw);
  if (!result.ok) {
    throw new Error(getTranslator('extensions')(validationMessageKeys[result.code]));
  }
  return result.data;
}
