/**
 * @file 提供内置网关登录账号的独立操作卡片组件。
 * @implementation 独立维护登录请求状态与防重入锁，避免与模型配置草稿表单互相锁定。
 * @updated 2026-11-27T22:20:00+08:00
 */
import { useRef } from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import type { ConfigInfo } from '@/api/types';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import { useGatewayLogin } from '@/use-query/settings/use-gateway-login';
import { errorMessage } from './shared';

export function BundledAccountCard({
  bundled,
}: {
  bundled: NonNullable<ConfigInfo['managedGateway']>;
}) {
  const { t } = useUiTranslation('inspector');
  const login = useGatewayLogin();
  const lock = useRef(false);

  async function signIn() {
    if (lock.current) return;
    lock.current = true;
    try {
      await login.mutateAsync();
    } catch {
      // The mutation exposes a sanitized login error below.
    } finally {
      lock.current = false;
    }
  }

  return (
    <fieldset className="settings-form-section" disabled={login.isPending}>
      <legend>{t('settings.bundledShunt')}</legend>
      <div className="settings-account">
        <div className="settings-account-summary">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>
              {bundled.accountPresent ? t('settings.accountFound') : t('settings.accountMissing')}
            </strong>
            <p>{t('settings.accountValidity')}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={login.isPending}
            onClick={() => void signIn()}
          >
            <ExternalLink data-icon="inline-start" aria-hidden="true" />
            {login.isPending ? t('settings.waitingForLogin') : t('settings.login')}
          </Button>
        </div>
        <p className="settings-help" role="status">
          {login.isPending
            ? t('settings.loginInstructions')
            : login.isSuccess
              ? t('settings.loginFinished')
              : t('settings.loginOpensBrowser')}
        </p>
        {login.error ? (
          <p className="settings-error" role="alert">
            {errorMessage(login.error)}
          </p>
        ) : null}
        <details className="settings-account-path">
          <summary>{t('settings.configLocation')}</summary>
          <code>{bundled.configPath}</code>
        </details>
      </div>
    </fieldset>
  );
}
