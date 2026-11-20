/**
 * @file 提供宿主管理的 Shunt 账户文件状态与显式 ChatGPT 登录。
 * @implementation 只检查账户文件是否存在；以固定二进制启动单个有时限的登录命令，丢弃输出并在取消或关闭时终止。
 * @updated 2026-11-20T19:00:00+08:00
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AppError } from '../shared/types.js';

export interface ManagedGatewayStatus {
  configPath: string;
  accountPresent: boolean;
}

interface ManagedGatewayPaths {
  configPath: string;
  accountsDir: string;
  binaryPath: string;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;

function managedPaths(env: NodeJS.ProcessEnv): ManagedGatewayPaths | undefined {
  const gateway = env.ATELIER_MANAGED_GATEWAY;
  const configPath = env.ATELIER_SHUNT_CONFIG;
  const binaryPath = env.ATELIER_SHUNT_BINARY;
  const accountsDir = env.SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR;
  if (!gateway || !configPath || !binaryPath || !accountsDir) return undefined;
  if (![configPath, binaryPath, accountsDir].every(isAbsolute)) return undefined;
  try {
    const url = new URL(gateway);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
  } catch {
    return undefined;
  }
  return { configPath, binaryPath, accountsDir };
}

/** One instance belongs to the app and must be disposed during shutdown. */
export class ManagedGatewayLogin {
  private readonly paths: ManagedGatewayPaths | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly shutdown = new AbortController();
  private active: Promise<ManagedGatewayStatus> | undefined;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = { ...env };
    this.paths = managedPaths(this.env);
  }

  async status(): Promise<ManagedGatewayStatus | undefined> {
    if (!this.paths) return undefined;
    let accountPresent = false;
    try {
      const entries = await readdir(this.paths.accountsDir, { withFileTypes: true });
      // Mirror Shunt's account filename rules without reading identities or tokens.
      accountPresent = entries.some((entry) => {
        if (!entry.isFile() || !entry.name.endsWith('.json')) return false;
        const name = entry.name.slice(0, -5);
        return /^[a-z0-9_@+-](?:[a-z0-9._@+-]*[a-z0-9_@+-])?$/u.test(name);
      });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new AppError('GATEWAY_ACCOUNT_STATUS_FAILED', '无法检查内置 Shunt 的账户文件。', 503);
      }
    }
    return { configPath: this.paths.configPath, accountPresent };
  }

  async login(signal?: AbortSignal): Promise<ManagedGatewayStatus> {
    if (this.shutdown.signal.aborted) {
      throw new AppError('SHUTTING_DOWN', '服务正在关闭。', 503);
    }
    if (!this.paths) {
      throw new AppError('MANAGED_GATEWAY_UNAVAILABLE', '当前环境没有内置 Shunt。', 409);
    }
    if (this.active) {
      throw new AppError('GATEWAY_LOGIN_BUSY', '正在等待 ChatGPT 登录，请完成当前登录。', 409);
    }
    const combined = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    const operation = this.performLogin(this.paths, combined);
    this.active = operation;
    try {
      return await operation;
    } finally {
      this.active = undefined;
    }
  }

  async dispose(): Promise<void> {
    this.shutdown.abort();
    await this.active?.catch(() => undefined);
  }

  private async performLogin(
    paths: ManagedGatewayPaths,
    signal: AbortSignal,
  ): Promise<ManagedGatewayStatus> {
    const cancelled = () => new AppError('GATEWAY_LOGIN_CANCELLED', 'ChatGPT 登录已取消。', 409);
    if (signal.aborted) throw cancelled();
    let binary: string;
    try {
      binary = await realpath(paths.binaryPath);
      if (!(await stat(binary)).isFile()) throw new Error('Not a file');
      await access(binary, constants.X_OK);
    } catch {
      throw new AppError('GATEWAY_LOGIN_UNAVAILABLE', '无法启动内置 Shunt，请检查应用安装。', 503);
    }
    if (signal.aborted) throw cancelled();
    const env: NodeJS.ProcessEnv = {
      ...this.env,
      SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR: paths.accountsDir,
    };
    if (env.ATELIER_MANAGED_GATEWAY_TOKEN) {
      env.ATELIER_SHUNT_CLIENT_TOKENS = `atelier:${env.ATELIER_MANAGED_GATEWAY_TOKEN}`;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        binary,
        ['login', 'chatgpt-plan', '--name', 'atelier', '--config', paths.configPath],
        { env, shell: false, stdio: 'ignore', windowsHide: true },
      );
      let failure: AppError | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: AppError) => {
        if (failure) return;
        failure = error;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      };
      const abort = () => stop(cancelled());
      const deadline = setTimeout(
        () => stop(new AppError('GATEWAY_LOGIN_TIMEOUT', '登录等待已超过 5 分钟，请重试。', 408)),
        LOGIN_TIMEOUT_MS,
      );
      const cleanup = () => {
        clearTimeout(deadline);
        clearTimeout(killTimer);
        signal.removeEventListener('abort', abort);
      };
      child.once('error', () => {
        cleanup();
        reject(
          failure ??
            new AppError('GATEWAY_LOGIN_UNAVAILABLE', '无法启动内置 Shunt，请检查应用安装。', 503),
        );
      });
      child.once('close', (code) => {
        cleanup();
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new AppError('GATEWAY_LOGIN_FAILED', 'ChatGPT 登录未完成，请重试。', 502));
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const status = await this.status();
    if (!status) throw new AppError('MANAGED_GATEWAY_UNAVAILABLE', '当前环境没有内置 Shunt。', 409);
    return status;
  }
}
