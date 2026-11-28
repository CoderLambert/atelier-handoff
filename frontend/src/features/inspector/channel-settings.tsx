/**
 * @file 提供设置页中的外部消息通道（Telegram Bot）配置、配对审批与已绑定账号管理卡片。
 * @implementation 通过 window.atelierChannels 桥接安全读写掩码 Token、测试连接、启停开关、实时接收配对请求并支持一键解绑。
 * @updated 2026-11-28T11:20:00+08:00
 */
import { useEffect, useId, useState } from 'react';
import {
  Check,
  CheckCircle2,
  LoaderCircle,
  Plug,
  Send,
  ShieldCheck,
  Unlink,
  X,
} from 'lucide-react';
import type { ChannelStateSnapshot, ChannelTestResult } from '@shared/channels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useUiTranslation } from '@/i18n';

const statusBadgeVariant = {
  connected: 'default',
  connecting: 'secondary',
  disconnected: 'outline',
  error: 'destructive',
} as const;

export function ChannelSettings() {
  const { t } = useUiTranslation('inspector');
  const bridge = typeof window !== 'undefined' ? window.atelierChannels : undefined;
  const tokenInputId = useId();
  const toggleId = useId();
  const schedulePushId = useId();

  const [snapshot, setSnapshot] = useState<ChannelStateSnapshot | null>(null);
  const [loading, setLoading] = useState(Boolean(bridge));
  const [tokenInput, setTokenInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [pairingBusyId, setPairingBusyId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ChannelTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    setLoading(true);
    void bridge
      .getState('telegram')
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : t('settings.channelsLoadFailed'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const unsubStatus = bridge.onStatusChanged((status) => {
      if (status.channel !== 'telegram') return;
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              status,
              config: {
                ...prev.config,
                botUsername: status.botUsername ?? prev.config.botUsername,
              },
            }
          : prev,
      );
    });

    const unsubPairing = bridge.onPairingRequested((pairing) => {
      if (pairing.channel !== 'telegram') return;
      setSnapshot((prev) => {
        if (!prev) return prev;
        const others = prev.pendingPairings.filter((item) => item.chatId !== pairing.chatId);
        return {
          ...prev,
          pendingPairings: [pairing, ...others],
        };
      });
    });

    return () => {
      active = false;
      unsubStatus();
      unsubPairing();
    };
  }, [bridge, t]);

  if (!bridge) {
    return (
      <div className="settings-notice" role="status">
        <Send aria-hidden="true" />
        <span>{t('settings.channelsDesktopOnly')}</span>
      </div>
    );
  }

  if (loading && !snapshot) {
    return (
      <div className="settings-notice" role="status">
        <LoaderCircle className="settings-loading-icon" aria-hidden="true" />
        <span>{t('settings.loading')}</span>
      </div>
    );
  }

  const config = snapshot?.config;
  const status = snapshot?.status;
  const pendingPairings = snapshot?.pendingPairings ?? [];
  const bindings = snapshot?.bindings ?? [];
  const state = status?.state ?? 'disconnected';
  const busy = saving || toggling || testing;

  async function handleSave() {
    if (!bridge || !tokenInput.trim()) return;
    setSaving(true);
    setError(null);
    setTestResult(null);
    try {
      const next = await bridge.saveConfig({
        channel: 'telegram',
        token: tokenInput.trim(),
      });
      setSnapshot(next);
      setTokenInput('');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('settings.channelsSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!bridge) return;
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await bridge.testConnection({
        channel: 'telegram',
        ...(tokenInput.trim() ? { token: tokenInput.trim() } : {}),
      });
      setTestResult(result);
      if (result.ok) {
        const refreshed = await bridge.getState('telegram');
        setSnapshot(refreshed);
      }
    } catch (cause: unknown) {
      setTestResult({
        ok: false,
        botUsername: null,
        error: cause instanceof Error ? cause.message : t('settings.channelsTestFailed'),
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleToggle(checked: boolean) {
    if (!bridge) return;
    setToggling(true);
    setError(null);
    try {
      const next = await bridge.toggle({ channel: 'telegram', enabled: checked });
      setSnapshot(next);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('settings.channelsToggleFailed'));
    } finally {
      setToggling(false);
    }
  }

  async function handleSchedulePushToggle(checked: boolean) {
    if (!bridge) return;
    setSaving(true);
    setError(null);
    try {
      const next = await bridge.saveConfig({
        channel: 'telegram',
        pushScheduleResults: checked,
      });
      setSnapshot(next);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('settings.channelsSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleApprovePairing(chatId: string) {
    if (!bridge) return;
    setPairingBusyId(chatId);
    setError(null);
    try {
      const next = await bridge.approvePairing({ channel: 'telegram', chatId });
      setSnapshot(next);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('settings.channelsPairingActionFailed'));
    } finally {
      setPairingBusyId(null);
    }
  }

  async function handleRejectPairing(chatId: string) {
    if (!bridge) return;
    setPairingBusyId(chatId);
    setError(null);
    try {
      const next = await bridge.rejectPairing({ channel: 'telegram', chatId });
      setSnapshot(next);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('settings.channelsPairingActionFailed'));
    } finally {
      setPairingBusyId(null);
    }
  }

  async function handleUnbind(chatId: string) {
    if (!bridge) return;
    setPairingBusyId(chatId);
    setError(null);
    try {
      const next = await bridge.unbind({ channel: 'telegram', chatId });
      setSnapshot(next);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('settings.channelsPairingActionFailed'));
    } finally {
      setPairingBusyId(null);
    }
  }

  return (
    <div className="settings-form">
      <fieldset className="settings-form-section" disabled={busy}>
        <legend>{t('settings.channelsTelegramTitle')}</legend>
        <p className="settings-section-description">{t('settings.channelsTelegramDescription')}</p>

        <div className="settings-execution-toggle">
          <div className="settings-field-copy">
            <label htmlFor={toggleId}>{t('settings.channelsTelegramEnable')}</label>
            <p>{t('settings.channelsTelegramEnableDescription')}</p>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={statusBadgeVariant[state]}>
              {t(`settings.channelsStatus.${state}`)}
            </Badge>
            <Switch
              id={toggleId}
              checked={Boolean(config?.enabled)}
              disabled={busy || (!config?.hasToken && !config?.enabled)}
              onCheckedChange={(checked) => void handleToggle(checked)}
            />
          </div>
        </div>

        <div className="settings-field-row">
          <div className="settings-field-copy">
            <label htmlFor={tokenInputId}>{t('settings.channelsTelegramToken')}</label>
            <p>{t('settings.channelsTelegramTokenDescription')}</p>
          </div>
          <div className="settings-field-control">
            <Input
              id={tokenInputId}
              type="password"
              autoComplete="off"
              className="settings-input"
              value={tokenInput}
              placeholder={
                config?.hasToken
                  ? config.maskedToken
                  : t('settings.channelsTelegramTokenPlaceholder')
              }
              onChange={(event) => setTokenInput(event.target.value)}
            />
            <div className="settings-model-actions">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || (!tokenInput.trim() && !config?.hasToken)}
                onClick={() => void handleTest()}
              >
                {testing ? (
                  <LoaderCircle
                    className="settings-loading-icon"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                ) : (
                  <Plug data-icon="inline-start" aria-hidden="true" />
                )}
                {t('settings.channelsTestConnection')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy || !tokenInput.trim()}
                onClick={() => void handleSave()}
              >
                {saving ? (
                  <LoaderCircle
                    className="settings-loading-icon"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                ) : null}
                {t('settings.save')}
              </Button>
            </div>
            {config?.botUsername ? (
              <p className="settings-help">
                {t('settings.channelsConnectedBot', { bot: config.botUsername })}
              </p>
            ) : null}
          </div>
        </div>

        <div className="settings-execution-toggle">
          <div className="settings-field-copy">
            <label htmlFor={schedulePushId}>{t('settings.channelsPushScheduleResults')}</label>
            <p>{t('settings.channelsPushScheduleResultsDescription')}</p>
          </div>
          <Switch
            id={schedulePushId}
            checked={Boolean(config?.pushScheduleResults)}
            disabled={busy}
            onCheckedChange={(checked) => void handleSchedulePushToggle(checked)}
          />
        </div>

        {testResult ? (
          <div
            className="settings-connection"
            data-connected={testResult.ok ? 'true' : undefined}
            role="status"
          >
            <CheckCircle2 aria-hidden="true" />
            <div>
              <strong>
                {testResult.ok
                  ? t('settings.channelsTestSuccess', { bot: testResult.botUsername ?? 'Bot' })
                  : t('settings.channelsTestFailed')}
              </strong>
              {testResult.error ? <p>{testResult.error}</p> : null}
            </div>
          </div>
        ) : null}

        {status?.error ? (
          <p className="settings-error" role="alert">
            {status.error}
          </p>
        ) : null}

        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="settings-form-section">
        <legend>{t('settings.channelsPendingPairingsTitle')}</legend>
        <p className="settings-section-description">
          {t('settings.channelsPendingPairingsDescription')}
        </p>
        {pendingPairings.length === 0 ? (
          <p className="settings-help">{t('settings.channelsPendingPairingsEmpty')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {pendingPairings.map((item) => {
              const rowBusy = pairingBusyId === item.chatId;
              return (
                <div
                  key={`${item.channel}:${item.chatId}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 px-3.5 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
                      <span className="font-medium">
                        {item.senderName}
                        {item.senderUsername ? ` (@${item.senderUsername})` : ''}
                      </span>
                      <Badge variant="secondary" className="font-mono tracking-wider">
                        {item.code}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('settings.channelsChatIdLabel', { chatId: item.chatId })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={rowBusy}
                      onClick={() => void handleRejectPairing(item.chatId)}
                    >
                      <X data-icon="inline-start" aria-hidden="true" />
                      {t('settings.channelsRejectPairing')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={rowBusy}
                      onClick={() => void handleApprovePairing(item.chatId)}
                    >
                      {rowBusy ? (
                        <LoaderCircle
                          className="settings-loading-icon"
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                      ) : (
                        <Check data-icon="inline-start" aria-hidden="true" />
                      )}
                      {t('settings.channelsApprovePairing')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </fieldset>

      <fieldset className="settings-form-section">
        <legend>{t('settings.channelsBindingsTitle')}</legend>
        <p className="settings-section-description">{t('settings.channelsBindingsDescription')}</p>
        {bindings.length === 0 ? (
          <p className="settings-help">{t('settings.channelsBindingsEmpty')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {bindings.map((binding) => {
              const rowBusy = pairingBusyId === binding.chatId;
              return (
                <div
                  key={binding.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 px-3.5 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{binding.label}</span>
                      <Badge variant="outline">{binding.channel}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('settings.channelsChatIdLabel', { chatId: binding.chatId })}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={rowBusy}
                    onClick={() => void handleUnbind(binding.chatId)}
                  >
                    <Unlink data-icon="inline-start" aria-hidden="true" />
                    {t('settings.channelsUnbind')}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </fieldset>
    </div>
  );
}
