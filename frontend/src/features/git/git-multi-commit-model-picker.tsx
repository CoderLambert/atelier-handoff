/**
 * @file 在多提交规划中复用聊天的模型与推理等级选择器。
 * @implementation 仅提供多提交的独立偏好状态，模型目录和档位规则由共享选择器处理。
 * @updated 2026-11-25T00:00:00+08:00
 */
import type { ReasoningEffort } from '@shared/types';
import { useUiTranslation } from '@/i18n';
import { ModelPicker } from '@/features/chat/model-picker';
import './git-multi-commit-model-picker.css';

export function GitMultiCommitModelPicker({
  model,
  effort,
  defaultModel,
  disabled,
  onModelChange,
  onEffortChange,
}: {
  model?: string;
  effort?: ReasoningEffort;
  defaultModel?: string;
  disabled: boolean;
  onModelChange: (model?: string) => void;
  onEffortChange: (effort?: ReasoningEffort) => void;
}) {
  const { t } = useUiTranslation('git');
  return (
    <div className="git-multi-commit-model-picker">
      <p>{t('multi.model.label')}</p>
      <div className="git-multi-commit-model-controls">
        <ModelPicker
          model={model}
          effort={effort}
          defaultModel={defaultModel ?? ''}
          disabled={disabled || !defaultModel}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
        />
      </div>
      <p>{t('multi.model.savedHelp')}</p>
    </div>
  );
}
