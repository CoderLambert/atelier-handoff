/**
 * @file 提供模型、布局、快捷操作、通知和诊断设置页面。
 * @implementation 维护网关与执行偏好，将草稿表单与即点即存的账号/Magpie 卡片解耦，避免不同提交模型互相锁定。
 * @updated 2026-11-27T22:20:00+08:00
 */
import { useUiTranslation, getTranslator, useUiLanguage } from '@/i18n';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  CircleCheck,
  CircleHelp,
  Download,
  LayoutPanelLeft,
  Keyboard,
  LoaderCircle,
  Plug,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import { magpieModelPrefix } from '@shared/types';
import type { ConfigInfo } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { desktopFilesBridge } from '@/desktop-files';
import { useAppConfig } from '@/use-query/settings/use-app-config';
import { useGatewayModels } from '@/use-query/settings/use-gateway-models';
import { useUpdateAppConfig } from '@/use-query/settings/use-update-app-config';
import { errorMessage } from './shared';
import { WorkspaceLayoutForm, type WorkspaceLayoutFormProps } from './workspace-layout-form';
import { NotificationSettings } from './notification-settings';
import { BundledAccountCard } from './settings-account-card';
import { MagpieToggleCard } from './settings-magpie-card';
import {
  normalizeGatewayUrl,
  validateSettingsDraft,
  type SettingsValidationError,
} from './settings-validation';
import { ShortcutSettings } from '@/features/shortcuts';
import type { SettingsSection } from '@/app/types';
import './settings-page.css';
import { Input } from '@/components/ui/input';

export type { SettingsSection } from '@/app/types';

export interface SettingsPageProps {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  layout: WorkspaceLayoutFormProps;
  onBack?: () => void;
}

function translatedSections() {
  const t = getTranslator('inspector');
  const shortcuts = getTranslator('shortcuts');
  return [
    {
      id: 'models',
      label: t('settings.models'),
      description: t('settings.modelsNavDescription'),
      icon: Plug,
    },
    {
      id: 'layout',
      label: t('settings.layout'),
      description: t('settings.layoutNavDescription'),
      icon: LayoutPanelLeft,
    },
    {
      id: 'shortcuts',
      label: shortcuts('settingsTitle'),
      description: shortcuts('settingsNavDescription'),
      icon: Keyboard,
    },
    {
      id: 'notifications',
      label: t('settings.notifications'),
      description: t('settings.notificationsNavDescription'),
      icon: Bell,
    },
    {
      id: 'diagnostics',
      label: t('settings.diagnostics'),
      description: t('settings.diagnosticsNavDescription'),
      icon: Activity,
    },
  ] as const;
}

export default function SettingsPage({
  section,
  onSectionChange,
  layout,
  onBack,
}: SettingsPageProps) {
  const { t } = useUiTranslation('inspector');
  const [activeSection, setActiveSection] = useState<SettingsSection>(section);

  useEffect(() => {
    setActiveSection(section);
  }, [section]);

  const currentSection = activeSection;

  // Keep visited forms mounted so changing categories preserves an unsaved draft.
  const [visited, setVisited] = useState<SettingsSection[]>([currentSection]);
  if (!visited.includes(currentSection)) setVisited([...visited, currentSection]);

  function handleSectionChange(next: SettingsSection) {
    setActiveSection(next);
    onSectionChange(next);
  }

  return (
    <div className="settings-page">
      <header className="settings-page-header">
        <div className="settings-page-heading">
          <span className="settings-page-mark" aria-hidden="true">
            <Settings2 />
          </span>
          <div>
            <h1>{t('settings.title')}</h1>
            <p>{t('settings.description')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-start justify-end gap-4">
          <LanguageSettings />
          {onBack ? (
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft data-icon="inline-start" aria-hidden="true" />
              {t('settings.back')}
            </Button>
          ) : null}
        </div>
      </header>
      <div className="settings-page-body">
        <nav className="settings-page-nav" aria-label={t('settings.categories')}>
          {translatedSections().map(({ id, label, description, icon: SectionIcon }) => (
            <Button
              key={id}
              variant="ghost"
              className="settings-page-nav-item"
              aria-label={label}
              aria-current={currentSection === id ? 'page' : undefined}
              onClick={() => handleSectionChange(id)}
            >
              <SectionIcon data-icon="inline-start" aria-hidden="true" />
              <span className="settings-page-nav-copy">
                <span>{label}</span>
                <span className="settings-page-nav-description">{description}</span>
              </span>
              {currentSection === id ? (
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              ) : null}
            </Button>
          ))}
          <p className="settings-page-nav-note">{t('settings.localSettings')}</p>
        </nav>
        <div className="settings-page-content">
          {visited.includes('models') ? (
            <section hidden={currentSection !== 'models'} aria-labelledby="settings-models-heading">
              <div className="settings-section-intro">
                <h2 id="settings-models-heading">{t('settings.models')}</h2>
                <p>{t('settings.modelsDescription')}</p>
              </div>
              <GatewaySettings active={currentSection === 'models'} />
            </section>
          ) : null}
          {visited.includes('layout') ? (
            <section hidden={currentSection !== 'layout'} aria-labelledby="settings-layout-heading">
              <div className="settings-section-intro">
                <h2 id="settings-layout-heading">{t('settings.layout')}</h2>
                <p>{t('settings.layoutDescription')}</p>
              </div>
              <WorkspaceLayoutForm {...layout} />
            </section>
          ) : null}
          {visited.includes('shortcuts') ? (
            <section hidden={currentSection !== 'shortcuts'}>
              <ShortcutSettings />
            </section>
          ) : null}
          {visited.includes('notifications') ? (
            <section
              hidden={currentSection !== 'notifications'}
              aria-labelledby="settings-notifications-heading"
            >
              <div className="settings-section-intro">
                <h2 id="settings-notifications-heading">{t('settings.notifications')}</h2>
                <p>{t('settings.notificationsDescription')}</p>
              </div>
              <NotificationSettings />
            </section>
          ) : null}
          {visited.includes('diagnostics') ? (
            <section
              hidden={currentSection !== 'diagnostics'}
              aria-labelledby="settings-diagnostics-heading"
            >
              <div className="settings-section-intro">
                <h2 id="settings-diagnostics-heading">{t('settings.diagnostics')}</h2>
                <p>{t('settings.diagnosticsDescription')}</p>
              </div>
              <DiagnosticExport />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function LanguageSettings() {
  const { t } = useUiTranslation('inspector');
  const { locale, saveLocale, pending, error } = useUiLanguage();
  const id = useId();
  return (
    <div className="flex min-w-48 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {t('settings.language')}
      </label>
      <Select
        value={locale}
        disabled={pending}
        onValueChange={(value) => {
          if (value === 'zh-CN' || value === 'en') void saveLocale(value);
        }}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          aria-describedby={`${id}-status`}
          aria-invalid={Boolean(error)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          <SelectGroup>
            <SelectItem value="zh-CN">{t('settings.chinese')}</SelectItem>
            <SelectItem value="en">{t('settings.english')}</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <p
        id={`${id}-status`}
        role={error ? 'alert' : 'status'}
        className={error ? 'settings-error' : 'settings-help'}
      >
        {error ?? t(pending ? 'settings.languageSaving' : 'settings.languageHint')}
      </p>
    </div>
  );
}

function GatewaySettings({ active }: { active: boolean }) {
  const { t } = useUiTranslation('inspector');
  const settings = useAppConfig();
  return (
    <>
      {settings.isPending ? (
        <p className="settings-notice" role="status">
          <LoaderCircle className="settings-loading-icon" aria-hidden="true" />
          {t('settings.loading')}
        </p>
      ) : null}
      {settings.error ? (
        <div className="settings-notice settings-notice-error" role="alert">
          <span>{errorMessage(settings.error)}</span>
          <Button variant="outline" size="sm" onClick={() => void settings.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : null}
      {settings.data ? <SettingsForm initial={settings.data} active={active} /> : null}
    </>
  );
}

function DiagnosticExport() {
  const { t } = useUiTranslation('inspector');
  const native = desktopFilesBridge();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<'saved' | 'canceled'>();
  const [error, setError] = useState<unknown>();
  const lock = useRef(false);
  async function save() {
    if (!native || lock.current) return;
    lock.current = true;
    setPending(true);
    setStatus(undefined);
    setError(undefined);
    try {
      setStatus((await native.exportDiagnostics()) ? 'saved' : 'canceled');
    } catch (cause) {
      setError(cause);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return (
    <div className="settings-diagnostics">
      <div className="settings-diagnostics-icon" aria-hidden="true">
        <Activity />
      </div>
      <h3>{t('settings.exportTitle')}</h3>
      <p>{t('settings.exportDescription')}</p>
      <Button disabled={!native || pending} onClick={() => void save()}>
        {pending ? (
          <LoaderCircle
            className="settings-loading-icon"
            data-icon="inline-start"
            aria-hidden="true"
          />
        ) : (
          <Download data-icon="inline-start" aria-hidden="true" />
        )}
        {pending ? t('settings.exporting') : t('settings.export')}
      </Button>
      {!native ? <p className="settings-help">{t('settings.desktopExportHint')}</p> : null}
      {status ? (
        <p role="status">
          {t(status === 'saved' ? 'settings.diagnosticsSaved' : 'settings.exportCanceled')}
        </p>
      ) : null}
      {error !== undefined ? (
        <p className="settings-error" role="alert">
          {errorMessage(error)}
        </p>
      ) : null}
    </div>
  );
}

function SettingsForm({ initial, active }: { initial: ConfigInfo; active: boolean }) {
  const { t } = useUiTranslation('inspector');
  const id = useId();
  const [gateway, setGateway] = useState(
    initial.managedGateway?.externalGateway ?? initial.config.gateway,
  );
  const [managedGateway, setManagedGateway] = useState(initial.config.managedGateway !== false);
  const [model, setModel] = useState(initial.config.model);
  const [manualEntry, setManualEntry] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [limitExecution, setLimitExecution] = useState(initial.config.limitExecution ?? false);
  const [maxTurns, setMaxTurns] = useState(String(initial.config.maxTurns));
  const [timeoutMs, setTimeoutMs] = useState(String(initial.config.timeoutMs));
  const [validation, setValidation] = useState<SettingsValidationError>();
  const [saved, setSaved] = useState<ConfigInfo>();
  const lock = useRef(false);
  const mutation = useUpdateAppConfig();
  const bundled = initial.managedGateway;
  const usingBundled = Boolean(bundled && managedGateway);
  const magpieEnabled = initial.config.magpieEnabled === true;
  const magpieModelDisabled = !magpieEnabled && model.startsWith(magpieModelPrefix);
  const formBusy = mutation.isPending;
  const sourceChanged =
    usingBundled !== Boolean(bundled && initial.config.managedGateway !== false) ||
    (!usingBundled && normalizeGatewayUrl(gateway) !== normalizeGatewayUrl(initial.config.gateway));
  const catalog = useGatewayModels(active && !sourceChanged && !formBusy);
  const models = sourceChanged ? [] : (catalog.data?.models ?? []);
  const selectedModel = models.find((entry) => entry.id === model);
  const unavailableModel = Boolean(catalog.data && !selectedModel && !sourceChanged);
  const dirty =
    sourceChanged ||
    model !== initial.config.model ||
    limitExecution !== (initial.config.limitExecution ?? false) ||
    maxTurns !== String(initial.config.maxTurns) ||
    timeoutMs !== String(initial.config.timeoutMs);
  const connection = initial.connection;

  const change = () => {
    setSaved(undefined);
    setValidation(undefined);
    mutation.reset();
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    setValidation(undefined);
    setSaved(undefined);
    const check = validateSettingsDraft({
      usingBundled,
      gateway,
      model,
      limitExecution,
      maxTurns,
      timeoutMs,
    });
    if (!check.ok) {
      setValidation(check.error);
      return;
    }

    lock.current = true;
    try {
      const data = await mutation.mutateAsync({
        gateway: normalizeGatewayUrl(gateway),
        ...(bundled ? { managedGateway } : {}),
        model: model.trim(),
        effort: initial.config.effort,
        limitExecution,
        maxTurns: check.validTurns ? check.turns : initial.config.maxTurns,
        timeoutMs: check.validTimeout ? check.timeout : initial.config.timeoutMs,
      });
      setModel(data.config.model);
      setGateway(data.managedGateway?.externalGateway ?? data.config.gateway);
      setManagedGateway(data.config.managedGateway !== false);
      setLimitExecution(data.config.limitExecution ?? false);
      setMaxTurns(String(data.config.maxTurns));
      setTimeoutMs(String(data.config.timeoutMs));
      setSaved(data);
    } catch {
      // The mutation exposes the server error while the draft stays intact.
    } finally {
      lock.current = false;
    }
  }

  return (
    <div className="settings-form">
      {usingBundled && bundled ? <BundledAccountCard bundled={bundled} /> : null}
      <MagpieToggleCard
        magpieEnabled={magpieEnabled}
        magpieUnavailable={Boolean(
          magpieEnabled && catalog.data?.discovery.magpie?.status === 'unavailable',
        )}
      />

      <form className="settings-form" onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className="settings-form-section" disabled={formBusy}>
          <legend>{t('settings.gatewayConnection')}</legend>
          <div className="settings-connection" role="status" data-connected={connection.available}>
            {connection.available ? (
              <CircleCheck aria-hidden="true" />
            ) : (
              <CircleHelp aria-hidden="true" />
            )}
            <div>
              <strong>
                {connection.available
                  ? t('settings.gatewayAvailable')
                  : t('settings.gatewayDisconnected')}
              </strong>
              <p>
                {t(
                  connection.available
                    ? 'settings.gatewayReachableHint'
                    : 'settings.gatewayUnreachableHint',
                )}
              </p>
            </div>
          </div>
          {bundled ? (
            <div className="settings-field-row">
              <div className="settings-field-copy">
                <label htmlFor={`${id}-gateway-source`}>{t('settings.gatewaySource')}</label>
                <p>{t('settings.gatewaySourceHint')}</p>
              </div>
              <Select
                value={managedGateway ? 'bundled' : 'external'}
                disabled={formBusy}
                onValueChange={(value) => {
                  change();
                  setModelOpen(false);
                  setManagedGateway(value === 'bundled');
                }}
              >
                <SelectTrigger id={`${id}-gateway-source`} className="w-full min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  <SelectGroup>
                    <SelectItem value="bundled">{t('settings.bundledShunt')}</SelectItem>
                    <SelectItem value="external">{t('settings.externalGateway')}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {!usingBundled ? (
            <div className="settings-field-row" data-invalid={validation?.field === 'gateway'}>
              <div className="settings-field-copy">
                <label htmlFor={`${id}-gateway`}>{t('settings.gatewayAddress')}</label>
                <p id={`${id}-gateway-help`}>{t('settings.gatewayAddressHint')}</p>
              </div>
              <Input
                id={`${id}-gateway`}
                className="field settings-input"
                autoComplete="url"
                type="url"
                required
                disabled={formBusy}
                value={gateway}
                aria-invalid={validation?.field === 'gateway'}
                aria-describedby={`${id}-gateway-help${validation?.field === 'gateway' ? ` ${id}-validation` : ''}`}
                onChange={(event) => {
                  change();
                  setModelOpen(false);
                  setGateway(event.target.value);
                }}
                placeholder="http://127.0.0.1:3001"
              />
            </div>
          ) : null}
          {sourceChanged ? (
            <p className="settings-source-notice" role="status">
              {t('settings.gatewayUnsaved')}
            </p>
          ) : null}
        </fieldset>

        <fieldset className="settings-form-section" disabled={formBusy}>
          <legend>{t('settings.defaultModel')}</legend>
          {magpieModelDisabled ? (
            <p className="settings-source-notice" role="status">
              {t('settings.magpieDisabledModel')}
            </p>
          ) : null}
          <p className="settings-section-description">{t('settings.defaultModelHint')}</p>
          <div className="settings-field-row" data-invalid={validation?.field === 'model'}>
            <div className="settings-field-copy">
              <label htmlFor={`${id}-model`}>
                {manualEntry ? t('settings.modelName') : t('settings.defaultModel')}
              </label>
              <p id={`${id}-model-help`}>
                {manualEntry ? t('settings.modelManualHint') : t('settings.modelSelectHint')}
              </p>
            </div>
            <div className="settings-field-control">
              {manualEntry ? (
                <Input
                  id={`${id}-model`}
                  className="field settings-input"
                  required
                  maxLength={200}
                  disabled={formBusy}
                  value={model}
                  onChange={(event) => {
                    change();
                    setModel(event.target.value);
                  }}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={validation?.field === 'model'}
                  aria-describedby={`${id}-model-help${validation?.field === 'model' ? ` ${id}-validation` : ''}`}
                  placeholder={t('settings.modelPlaceholder')}
                />
              ) : (
                <Select
                  value={`model:${model}`}
                  open={modelOpen && !sourceChanged && !formBusy}
                  onOpenChange={setModelOpen}
                  disabled={formBusy || sourceChanged}
                  onValueChange={(value) => {
                    const entry = models.find((item) => `model:${item.id}` === value);
                    if (entry) {
                      change();
                      setModel(entry.id);
                    }
                  }}
                >
                  <SelectTrigger
                    id={`${id}-model`}
                    className="w-full min-w-0 [&_[data-slot=select-value]]:min-w-0"
                    aria-invalid={validation?.field === 'model'}
                    aria-describedby={`${id}-model-help${validation?.field === 'model' ? ` ${id}-validation` : ''}`}
                    title={model}
                  >
                    <SelectValue>
                      <span className="truncate">{selectedModel?.displayName || model}</span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent position="popper" align="end" className="settings-model-options">
                    <SelectGroup>
                      <SelectLabel>{t('settings.gatewayModels')}</SelectLabel>
                      {!selectedModel && model ? (
                        <SelectItem
                          value={`model:${model}`}
                          textValue={model}
                          title={model}
                          disabled={magpieModelDisabled}
                        >
                          <span className="truncate">
                            {model}
                            {magpieModelDisabled
                              ? t('settings.disabledSuffix')
                              : t('settings.currentSettingSuffix')}
                          </span>
                        </SelectItem>
                      ) : null}
                    </SelectGroup>
                    {(['Shunt', 'Magpie'] as const).map((gateway) => {
                      const entries = models.filter(
                        (entry) => (entry.source === 'magpie' ? 'Magpie' : 'Shunt') === gateway,
                      );
                      if (!entries.length) return null;
                      return (
                        <SelectGroup key={gateway}>
                          <SelectLabel>{gateway}</SelectLabel>
                          {entries.map((entry) => (
                            <SelectItem
                              key={entry.id}
                              value={`model:${entry.id}`}
                              textValue={[entry.displayName, entry.id].filter(Boolean).join(' ')}
                              title={entry.id}
                            >
                              <span className="truncate">{entry.displayName || entry.id}</span>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
              <div className="settings-model-actions">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  disabled={formBusy}
                  onClick={() => setManualEntry(!manualEntry)}
                >
                  {manualEntry ? t('settings.selectModel') : t('settings.enterModel')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={formBusy || sourceChanged || catalog.isFetching}
                  onClick={() => void catalog.refresh()}
                >
                  <RefreshCw data-icon="inline-start" aria-hidden="true" />
                  {t('settings.refreshModels')}
                </Button>
              </div>
            </div>
          </div>
          {!sourceChanged ? (
            <div className="settings-catalog-status" aria-live="polite">
              {catalog.isFetching ? <p>{t('settings.loadingModels')}</p> : null}
              {catalog.isError ? (
                <p className="settings-error" role="alert">
                  {t('settings.modelsFailed', { error: errorMessage(catalog.error) })}
                </p>
              ) : catalog.data && !models.length ? (
                <p>{t('settings.emptyModels')}</p>
              ) : null}
              {unavailableModel ? <p>{t('settings.modelNotListed')}</p> : null}
              {catalog.data &&
              [catalog.data.discovery.routes.status, catalog.data.discovery.codex.status].some(
                (status) => ['partial', 'unavailable', 'stale'].includes(status),
              ) ? (
                <p>{t('settings.partialModels')}</p>
              ) : null}
            </div>
          ) : null}
        </fieldset>

        <fieldset className="settings-form-section" disabled={formBusy}>
          <legend>{t('settings.execution')}</legend>
          <div className="settings-execution-toggle">
            <div className="settings-field-copy">
              <label htmlFor={`${id}-limit`}>{t('settings.limitExecution')}</label>
              <p id={`${id}-limit-help`}>{t('settings.continuousExecution')}</p>
            </div>
            <Switch
              id={`${id}-limit`}
              checked={limitExecution}
              disabled={formBusy}
              aria-describedby={`${id}-limit-help`}
              onCheckedChange={(checked) => {
                change();
                setLimitExecution(checked);
              }}
            />
          </div>
          {limitExecution ? (
            <div className="settings-number-fields">
              <label className="settings-number-field" data-invalid={validation?.field === 'turns'}>
                {t('settings.maxTurns')}
                <Input
                  type="number"
                  required
                  min={1}
                  max={100}
                  step={1}
                  className="field settings-input"
                  disabled={formBusy}
                  value={maxTurns}
                  aria-invalid={validation?.field === 'turns'}
                  aria-describedby={
                    validation?.field === 'turns' ? `${id}-validation` : `${id}-turns-help`
                  }
                  onChange={(event) => {
                    change();
                    setMaxTurns(event.target.value);
                  }}
                />
                <span id={`${id}-turns-help`}>{t('settings.turnsRange')}</span>
              </label>
              <label
                className="settings-number-field"
                data-invalid={validation?.field === 'timeout'}
              >
                {t('settings.timeout')}
                <Input
                  type="number"
                  required
                  min={10000}
                  max={1800000}
                  step={1}
                  className="field settings-input"
                  disabled={formBusy}
                  value={timeoutMs}
                  aria-invalid={validation?.field === 'timeout'}
                  aria-describedby={
                    validation?.field === 'timeout' ? `${id}-validation` : `${id}-timeout-help`
                  }
                  onChange={(event) => {
                    change();
                    setTimeoutMs(event.target.value);
                  }}
                />
                <span id={`${id}-timeout-help`}>{t('settings.timeoutRange')}</span>
              </label>
            </div>
          ) : null}
          <p className="settings-help">
            {t('settings.commands', {
              status: initial.capabilities.commands
                ? t('settings.commandsAvailable')
                : t('settings.commandsUnavailable'),
            })}
          </p>
        </fieldset>

        <div className="settings-save-bar">
          <div className="settings-save-feedback" aria-live="polite">
            {validation ? (
              <p id={`${id}-validation`} className="settings-error" role="alert">
                {t(validation.messageKey)}
              </p>
            ) : null}
            {mutation.error ? (
              <p className="settings-error" role="alert">
                {errorMessage(mutation.error)}
              </p>
            ) : null}
            {saved ? (
              <p className="settings-saved" role="status">
                <Check aria-hidden="true" />
                {t(
                  saved.connection.available
                    ? 'settings.savedConnected'
                    : 'settings.savedDisconnected',
                )}
              </p>
            ) : !validation && !mutation.error ? (
              <p>{dirty ? t('settings.unsaved') : t('settings.saveHint')}</p>
            ) : null}
          </div>
          <Button type="submit" disabled={formBusy}>
            {mutation.isPending ? (
              <LoaderCircle
                className="settings-loading-icon"
                data-icon="inline-start"
                aria-hidden="true"
              />
            ) : null}
            {mutation.isPending ? t('settings.savingAndChecking') : t('settings.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
