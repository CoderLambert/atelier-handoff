/**
 * @file 管理多提交 AI 分析与对话修改的模型及推理强度选择状态。
 * @implementation 读取并更新多提交模型偏好，计算当前生效路由、固定推理强度与可用性校验结果。
 * @updated 2026-11-27T21:45:00+08:00
 */
import { gatewayModelSchema, magpieModelPrefix, type ReasoningEffort } from '@shared/models';
import { useAppConfig } from '@/use-query/settings/use-app-config';
import { useGatewayModels } from '@/use-query/settings/use-gateway-models';
import { useGitMultiCommitPreferences } from '@/use-query/settings/use-git-multi-commit-preferences';
import { useUpdateGitMultiCommitPreferences } from '@/use-query/settings/use-update-git-multi-commit-preferences';

export function useGitMultiCommitModelSelection({
  catalogEnabled,
  isBusy,
  shouldResetAttempt,
  onResetAttempt,
}: {
  catalogEnabled: boolean;
  isBusy: () => boolean;
  shouldResetAttempt: boolean;
  onResetAttempt: () => void;
}) {
  const config = useAppConfig();
  const preferences = useGitMultiCommitPreferences();
  const savePreferences = useUpdateGitMultiCommitPreferences();
  const catalog = useGatewayModels(catalogEnabled);
  const model = preferences.data?.model ?? undefined;
  const effort = preferences.data?.effort ?? undefined;
  const defaultModel = config.data?.config.model ?? catalog.data?.defaultModel;
  const effectiveModel = model ?? defaultModel;
  const currentRoute = catalog.data?.models.find((entry) => entry.id === effectiveModel);
  const fixedEffort = currentRoute?.effort;
  const unsupportedEffort =
    fixedEffort === undefined &&
    effort !== undefined &&
    currentRoute?.supportedEfforts !== undefined &&
    !currentRoute.supportedEfforts.includes(effort);
  const requestedEffort = fixedEffort === undefined ? effort : undefined;
  const modelValid = gatewayModelSchema.shape.id.safeParse(effectiveModel).success;
  const modelUnavailable =
    effectiveModel?.trim().startsWith(magpieModelPrefix) === true && !catalog.magpieEnabled;

  function selectModel(next?: string) {
    if (isBusy()) return;
    if (shouldResetAttempt) onResetAttempt();
    if (
      !preferences.data ||
      (next !== undefined && !gatewayModelSchema.shape.id.safeParse(next).success)
    )
      return;
    savePreferences.mutate({ model: next ?? null, effort: null });
  }

  function selectEffort(next?: ReasoningEffort) {
    if (isBusy() || !preferences.data || fixedEffort !== undefined) return;
    if (next && currentRoute?.supportedEfforts && !currentRoute.supportedEfforts.includes(next))
      return;
    if (shouldResetAttempt) onResetAttempt();
    savePreferences.mutate({ ...preferences.data, effort: next ?? null });
  }

  return {
    model,
    effort,
    defaultModel,
    effectiveModel,
    requestedEffort,
    modelValid,
    modelUnavailable,
    unsupportedEffort,
    catalog,
    preferencesReady: Boolean(preferences.data && !savePreferences.isPending),
    preferencesLoading: preferences.isPending,
    preferencesSaving: savePreferences.isPending,
    preferencesError: preferences.isError,
    preferencesSaveError: savePreferences.isError,
    retryPreferences: () => void preferences.refetch(),
    retrySavePreferences: () => {
      if (preferences.data) savePreferences.mutate(preferences.data);
    },
    selectModel,
    selectEffort,
  };
}
