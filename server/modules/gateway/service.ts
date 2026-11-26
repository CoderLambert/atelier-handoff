/**
 * @file 管理工作台的有效网关配置、连接探测和模型目录。
 * @implementation 合并持久配置与宿主托管地址，跟踪 Magpie 发现的取消状态，并随运行时释放登录进程。
 * @updated 2026-11-26T22:26:22+08:00
 */
import { AppError, type AppConfig, type GatewayModelCatalog } from '../../../shared/types.js';
import { commandsAvailable } from '../../commands.js';
import { gatewayModels } from '../../gateway-models.js';
import { gatewayToken } from '../../gateway-search.js';
import { magpieModel, magpieModels, magpieOrigin } from '../../magpie-models.js';
import { ManagedGatewayLogin } from '../../managed-gateway-login.js';

interface GatewaySettings {
  config(): AppConfig;
  setConfig(config: AppConfig): void;
}

export type GatewayConfigPatch = Partial<
  Pick<
    AppConfig,
    | 'gateway'
    | 'managedGateway'
    | 'magpieEnabled'
    | 'model'
    | 'limitExecution'
    | 'maxTurns'
    | 'timeoutMs'
  >
>;

export function createGatewayService({
  settings,
  nativeExecution,
  magpie: magpieAddress,
}: {
  settings: GatewaySettings;
  nativeExecution: boolean;
  magpie?: string;
}) {
  const gatewayLogin = new ManagedGatewayLogin();
  const managedOrigin = process.env.ATELIER_MANAGED_GATEWAY;
  const magpie = magpieOrigin(magpieAddress);
  let magpieDiscovery = new AbortController();

  function requireMagpieEnabled(): void {
    if (settings.config().magpieEnabled !== true)
      throw new AppError(
        'MAGPIE_DISABLED',
        'Magpie 接入已关闭。请在模型与网关设置中开启，或改选 Shunt 模型。',
        409,
      );
  }

  function effectiveConfig(): AppConfig {
    const saved = settings.config();
    const useManaged =
      managedOrigin &&
      (saved.managedGateway ??
        /^http:\/\/(?:127\.0\.0\.1|localhost):3001\/?$/u.test(saved.gateway));
    return useManaged
      ? { ...saved, gateway: managedOrigin, managedGateway: true }
      : { ...saved, managedGateway: managedOrigin ? false : undefined };
  }

  async function connection(config: AppConfig, usingMagpie = false) {
    try {
      const endpoint = config.gateway.replace(/\/$/, '') + (usingMagpie ? '/v1/models' : '/health');
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
        ...(usingMagpie ? { headers: { Authorization: `Bearer ${gatewayToken(config)}` } } : {}),
      });
      if (!response.ok) throw new Error();
      return { available: true, message: '本机网关可访问；模型认证以实际执行结果为准。' };
    } catch {
      return { available: false, message: '无法连接本机网关，请启动 Shunt 或检查设置。' };
    }
  }

  async function configInfo() {
    const config = effectiveConfig();
    const [status, gateway] = await Promise.all([connection(config), gatewayLogin.status()]);
    return {
      config,
      capabilities: { commands: commandsAvailable(), nativeExecution },
      connection: status,
      ...(gateway
        ? { managedGateway: { ...gateway, externalGateway: settings.config().gateway } }
        : {}),
    };
  }

  function update(patch: GatewayConfigPatch): void {
    const changes = { ...patch };
    if (changes.managedGateway && !managedOrigin)
      throw new AppError('MANAGED_GATEWAY_UNAVAILABLE', '内置 Shunt 当前不可用。', 409);
    if (changes.magpieEnabled && !magpie)
      throw new AppError(
        'MAGPIE_UNAVAILABLE',
        'Magpie 网关地址未配置，请检查工作台启动配置。',
        409,
      );
    if (changes.managedGateway && changes.gateway === managedOrigin) delete changes.gateway;
    if (changes.gateway) {
      const gateway = new URL(changes.gateway);
      if (
        !['http:', 'https:'].includes(gateway.protocol) ||
        !['127.0.0.1', 'localhost'].includes(gateway.hostname) ||
        gateway.username ||
        gateway.password ||
        gateway.search ||
        gateway.hash
      )
        throw new AppError('INVALID_GATEWAY', '首版只连接不含凭据的本机 Shunt 地址。');
      changes.gateway = changes.gateway.replace(/\/$/, '');
    }
    const setsLimits = changes.maxTurns !== undefined || changes.timeoutMs !== undefined;
    settings.setConfig({
      ...settings.config(),
      ...(setsLimits ? { limitExecution: true } : {}),
      ...changes,
    });
    if (changes.magpieEnabled === false) {
      magpieDiscovery.abort();
      magpieDiscovery = new AbortController();
    }
  }

  async function models(refresh: boolean): Promise<GatewayModelCatalog> {
    const config = effectiveConfig();
    const signal = magpieDiscovery.signal;
    const [catalog, additional] = await Promise.all([
      gatewayModels(config, undefined, { refresh }),
      magpie && config.magpieEnabled === true ? magpieModels(magpie, signal) : undefined,
    ]);
    catalog.models = catalog.models.filter(({ id }) => magpieModel(id) === undefined);
    if (additional && !signal.aborted && settings.config().magpieEnabled === true) {
      catalog.models.push(...additional.models);
      catalog.discovery.magpie = additional.discovery;
    }
    return catalog;
  }

  return {
    effectiveConfig,
    requireMagpieEnabled,
    magpie,
    connection,
    configInfo,
    update,
    models,
    login: () => gatewayLogin.login(),
    dispose: () => gatewayLogin.dispose(),
  };
}

export type GatewayService = ReturnType<typeof createGatewayService>;
