/**
 * @file 显示任务规划模式及高级设置。
 * @implementation 分别保存全局模式、当前模型覆盖和拆分提示，保留保存失败的提示词草稿。
 * @updated 2026-11-28T21:12:24+08:00
 */
import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { gatewayModelSchema } from '@shared/models';
import {
  defaultTaskPlanningPrompt,
  taskPlanningModeSchema,
  taskPlanningPromptLimit,
  type TaskPlanningMode,
  type TaskPlanningSettings as Preferences,
} from '@shared/task-planning';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useUiTranslation } from '@/i18n';
import { useGatewayModels } from '@/use-query/settings/use-gateway-models';
import { useTaskPlanning } from '@/use-query/settings/use-task-planning';
import { useUpdateTaskPlanning } from '@/use-query/settings/use-update-task-planning';

const labels = {
  auto: 'settings.taskPlanningAuto',
  'on-request': 'settings.taskPlanningOnRequest',
  off: 'settings.taskPlanningOff',
} as const;
const descriptions = {
  auto: 'settings.taskPlanningAutoHint',
  'on-request': 'settings.taskPlanningOnRequestHint',
  off: 'settings.taskPlanningOffHint',
} as const;

export function TaskPlanningSettings({ active }: { active: boolean }) {
  const { t } = useUiTranslation('inspector');
  const query = useTaskPlanning();
  return (
    <>
      {query.isPending ? <p role="status">{t('settings.loading')}</p> : null}
      {query.isError ? (
        <div className="settings-notice settings-notice-error" role="alert">
          {t('settings.taskPlanningLoadError')}
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : null}
      {query.data ? <TaskPlanningForm settings={query.data} active={active} /> : null}
    </>
  );
}

function ModeSelect({
  id,
  hint,
  mode,
  pending,
  onChange,
}: {
  id: string;
  hint?: string;
  mode: TaskPlanningMode | 'inherit';
  pending: boolean;
  onChange: (mode: TaskPlanningMode | null) => void;
}) {
  const { t } = useUiTranslation('inspector');
  return (
    <Select
      value={mode}
      disabled={pending}
      onValueChange={(value) => {
        if (value === 'inherit') onChange(null);
        else {
          const parsed = taskPlanningModeSchema.safeParse(value);
          if (parsed.success) onChange(parsed.data);
        }
      }}
    >
      <SelectTrigger id={id} aria-describedby={hint} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {hint ? null : <SelectItem value="inherit">{t('settings.taskPlanningInherit')}</SelectItem>}
        {taskPlanningModeSchema.options.map((value) => (
          <SelectItem key={value} value={value}>
            {t(labels[value])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TaskPlanningForm({ settings, active }: { settings: Preferences; active: boolean }) {
  const { t } = useUiTranslation('inspector');
  const id = useId();
  const update = useUpdateTaskPlanning();
  const [advanced, setAdvanced] = useState(false);
  const [model, setModel] = useState('');
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const catalog = useGatewayModels(active && advanced);
  const models = new Map(
    (catalog.data?.models ?? []).map(({ id, displayName }) => [id, displayName ?? id]),
  );
  for (const entry of settings.modelOverrides)
    if (!models.has(entry.model)) models.set(entry.model, entry.model);
  const parsedModel = gatewayModelSchema.shape.id.safeParse(model);
  const selected = parsedModel.success ? parsedModel.data : null;
  const override = settings.modelOverrides.find((entry) => entry.model === selected)?.mode;
  const storedPrompt = settings.prompt ?? defaultTaskPlanningPrompt;
  const draft = promptDraft ?? storedPrompt;

  function savePrompt(prompt: string | null) {
    update.mutate({ prompt }, { onSuccess: () => setPromptDraft(null) });
  }

  return (
    <div className="settings-form max-w-3xl">
      <section className="settings-form-section">
        <Field className="max-w-sm">
          <FieldLabel htmlFor={id}>{t('settings.taskPlanningDefault')}</FieldLabel>
          <ModeSelect
            id={id}
            hint={`${id}-hint`}
            mode={settings.mode}
            pending={update.isPending}
            onChange={(mode) => {
              if (mode) update.mutate({ mode });
            }}
          />
          <FieldDescription id={`${id}-hint`}>{t(descriptions[settings.mode])}</FieldDescription>
        </Field>
        <details
          open={advanced}
          onToggle={(event) => setAdvanced(event.currentTarget.open)}
          className="border-t border-border pt-4"
        >
          <summary className="flex cursor-pointer select-none items-center gap-2 rounded-sm text-sm font-medium focus-visible:outline focus-visible:outline-ring">
            <ChevronDown aria-hidden="true" className="size-4" />
            {t('settings.taskPlanningAdvanced')}
          </summary>
          <div className="mt-5 flex flex-col gap-7">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${id}-model`}>{t('settings.taskPlanningModel')}</FieldLabel>
                <Input
                  id={`${id}-model`}
                  value={model}
                  maxLength={200}
                  autoComplete="off"
                  list={`${id}-models`}
                  aria-describedby={`${id}-model-hint`}
                  aria-invalid={model.length > 0 && !selected}
                  onChange={(event) => setModel(event.target.value)}
                />
                <datalist id={`${id}-models`}>
                  {[...models].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </datalist>
                <FieldDescription id={`${id}-model-hint`}>
                  {t(
                    model && !selected
                      ? 'settings.taskPlanningInvalidModel'
                      : 'settings.taskPlanningModelHint',
                  )}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-override`}>
                  {t('settings.taskPlanningOverride')}
                </FieldLabel>
                <ModeSelect
                  id={`${id}-override`}
                  mode={override ?? 'inherit'}
                  pending={!selected || update.isPending}
                  onChange={(mode) => {
                    if (selected) update.mutate({ modelOverride: { model: selected, mode } });
                  }}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor={`${id}-prompt`}>{t('settings.taskPlanningPrompt')}</FieldLabel>
              <Textarea
                id={`${id}-prompt`}
                value={draft}
                rows={6}
                disabled={update.isPending}
                aria-describedby={`${id}-prompt-hint`}
                maxLength={taskPlanningPromptLimit}
                onChange={(event) => {
                  setPromptDraft(event.target.value);
                  update.reset();
                }}
              />
              <FieldDescription id={`${id}-prompt-hint`}>
                {t('settings.taskPlanningPromptHint')}
              </FieldDescription>
              <div className="flex flex-wrap gap-2 pt-2">
                <Button
                  size="sm"
                  onClick={() => savePrompt(draft.trim())}
                  disabled={update.isPending || !draft.trim() || draft.trim() === storedPrompt}
                >
                  {t('settings.taskPlanningSavePrompt')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (settings.prompt === null) setPromptDraft(null);
                    else savePrompt(null);
                  }}
                  disabled={update.isPending || (promptDraft === null && settings.prompt === null)}
                >
                  {t('settings.taskPlanningResetPrompt')}
                </Button>
              </div>
            </Field>
          </div>
        </details>
        {update.isError ? <FieldError>{t('settings.taskPlanningSaveError')}</FieldError> : null}
        {update.isSuccess ? (
          <p role="status" className="settings-help">
            {t('settings.taskPlanningSaved')}
          </p>
        ) : null}
      </section>
    </div>
  );
}
