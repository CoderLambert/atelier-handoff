/**
 * @file 监督独立的 Node 工作台运行时。
 * @implementation 校验私有握手，传递内置网关及可信 RTK 路径，按连接代次清理子进程并向当前运行时发起开发重启探测。
 * @updated 2026-12-08T12:00:00+00:00
 */
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { delimiter, isAbsolute, join } from 'node:path';
import { clearRtkEnvironment } from '../../shared/builtin-rtk.js';
import type { ManagedShuntConnection } from './managed-shunt.mjs';
import {
  desktopHostDeadlines,
  desktopHostReplySchema,
  desktopHostVersion,
  type DesktopHostFailure,
  type DesktopHostHello,
  type DesktopHostSystemResume,
} from '../../shared/desktop-host.js';

import {
  developmentRestartProbe,
  developmentRestartResult,
} from '../../shared/desktop-development-restart.js';
import { DesktopHostError, type DesktopFailureKey } from './i18n.mjs';

const failureKey = {
  PORT_IN_USE: 'host.failure.portInUse',
  DATA_LOCKED: 'host.failure.dataLocked',
  DATA_PATH: 'host.failure.dataPath',
  STARTUP_FAILED: 'host.failure.startupFailed',
} as const satisfies Record<DesktopHostFailure, DesktopFailureKey>;

interface LaunchOptions {
  packaged: boolean;
  root: string;
  dataDir: string;
  rtkBinary?: string;
}
interface Launch {
  child: ChildProcess;
  exited: Promise<void>;
  ready: boolean;
  retired: boolean;
  cancelStartup?: () => void;
  stop?: Promise<void>;
}

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, name);
    else if (child.exitCode === null && child.signalCode === null) child.kill(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.error('运行时进程清理失败。');
  }
}

export class RuntimeSupervisor {
  private current: Launch | undefined;

  constructor(
    private readonly options: LaunchOptions,
    private readonly onMessage: (child: ChildProcess, value: unknown) => void,
    private readonly onLost: (reason: DesktopHostError) => void,
  ) {}

  get connected(): boolean {
    return this.current?.ready === true && this.current.child.connected && !this.current.retired;
  }

  owns(child: ChildProcess): boolean {
    return this.current?.child === child && this.current.ready && !this.current.retired;
  }

  notifySystemResume(): void {
    const active = this.current;
    if (!active || !active.ready || active.retired || !active.child.connected) return;
    const message: DesktopHostSystemResume = {
      type: 'atelier-host:system-resume',
      protocolVersion: desktopHostVersion,
    };
    active.child.send(message, () => undefined);
  }

  prepareDevelopmentRestart(): Promise<boolean> {
    const child = this.current?.child;
    if (!child || !this.connected) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = randomUUID();
      const finish = (ready: boolean) => {
        clearTimeout(timeout);
        child.off('message', receive);
        child.off('disconnect', disconnect);
        resolve(ready);
      };
      const receive = (input: unknown) => {
        const result = developmentRestartResult.safeParse(input);
        if (result.success && result.data.id === id) finish(result.data.ready && this.owns(child));
      };
      const disconnect = () => finish(false);
      const timeout = setTimeout(disconnect, 2_000);
      child.on('message', receive);
      child.once('disconnect', disconnect);
      child.send(
        developmentRestartProbe.parse({ type: 'atelier-dev:prepare-restart', id }),
        (error) => {
          if (error) finish(false);
        },
      );
    });
  }

  async start(gateway?: ManagedShuntConnection): Promise<{ origin: string; pairing: string }> {
    if (this.current) throw new DesktopHostError('host.failure.notStopped');
    const { root, packaged, dataDir, rtkBinary } = this.options;
    if (rtkBinary !== undefined && !isAbsolute(rtkBinary))
      throw new DesktopHostError('host.failure.startupFailed');
    const nodeBin = join(root, 'bin');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ATELIER_DESKTOP_BROWSER: '1',
      ATELIER_DATA_DIR: dataDir,
      ATELIER_PORT: process.env.ATELIER_PORT ?? '0',
      ...(gateway
        ? {
            ATELIER_MANAGED_GATEWAY: gateway.origin,
            ATELIER_MANAGED_GATEWAY_TOKEN: gateway.token,
            ATELIER_SHUNT_BINARY: gateway.binary,
            ATELIER_SHUNT_CONFIG: gateway.configPath,
            SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR: gateway.accountsDirectory,
          }
        : {}),
    };
    clearRtkEnvironment(env);
    if (packaged) {
      env.PATH = [nodeBin, process.env.PATH].filter(Boolean).join(delimiter);
      delete env.NODE_PATH;
      delete env.NODE_OPTIONS;
    }
    const child = fork(
      join(root, packaged ? 'server/main.js' : 'server/main.ts'),
      rtkBinary ? ['--rtk-binary', rtkBinary] : [],
      {
        cwd: root,
        execPath: packaged
          ? join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node')
          : process.env.npm_node_execpath || 'node',
        execArgv: packaged ? [] : ['--env-file-if-exists=.env', '--import', 'tsx'],
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      },
    );
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('close', () => resolve());
    });
    const launch: Launch = { child, exited, ready: false, retired: false };
    this.current = launch;
    const hello: DesktopHostHello = {
      type: 'atelier-host:hello',
      protocolVersion: desktopHostVersion,
      generation: randomUUID(),
      pairing: randomBytes(32).toString('hex'),
    };
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let failed = false;
        const lost = (key: DesktopFailureKey, diagnostic?: unknown) => {
          clearTimeout(timeout);
          if (this.current !== launch || failed) return;
          failed = true;
          const reason = new DesktopHostError(key, diagnostic);
          if (launch.ready) {
            launch.ready = false;
            if (!launch.retired) this.onLost(reason);
          } else reject(reason);
        };
        const timeout = setTimeout(
          () => lost('host.failure.startupTimeout'),
          desktopHostDeadlines.ready,
        );
        launch.cancelStartup = () => lost('host.failure.startupCanceled');
        child.on('error', (error) => lost('host.failure.connectionFailed', error));
        child.once('disconnect', () => lost('host.failure.disconnected'));
        child.once('exit', (code, exitSignal) => {
          // Descendants may still exist after an unexpected exit of their process group leader.
          if (this.current === launch) signal(child, 'SIGKILL');
          lost('host.failure.exited', `exitCode=${code}; signal=${exitSignal}`);
        });
        child.on('message', (message: unknown) => {
          if (launch.retired || failed) return;
          if (launch.ready) {
            if (!developmentRestartResult.safeParse(message).success)
              this.onMessage(child, message);
            return;
          }
          const reply = desktopHostReplySchema.safeParse(message);
          if (!reply.success || reply.data.generation !== hello.generation) {
            lost('host.failure.protocolMismatch');
            return;
          }
          if (reply.data.type === 'atelier-host:failed') {
            lost(failureKey[reply.data.code]);
            return;
          }
          clearTimeout(timeout);
          launch.ready = true;
          launch.cancelStartup = undefined;
          resolve(reply.data.port);
        });
        child.send(hello, (error) => {
          if (error) lost('host.failure.connectionFailed', error);
        });
      });
      if (!this.owns(child) || !child.connected)
        throw new DesktopHostError('host.failure.disconnected');
      return { origin: `http://127.0.0.1:${port}`, pairing: hello.pairing };
    } catch (error) {
      if (this.current === launch) await this.stop();
      throw error;
    }
  }

  stop(): Promise<void> {
    const launch = this.current;
    if (!launch) return Promise.resolve();
    launch.retired = true;
    launch.cancelStartup?.();
    return (launch.stop ??= this.stopLaunch(launch));
  }

  private async stopLaunch(launch: Launch): Promise<void> {
    const { child } = launch;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // Node handles IPC disconnect as a graceful shutdown on every platform.
      if (child.connected) child.disconnect();
      await Promise.race([
        launch.exited,
        new Promise<void>((resolve) => {
          deadline = setTimeout(() => {
            console.error('工作台服务未及时结束，已请求强制清理运行时进程。');
            signal(child, 'SIGKILL');
            resolve();
          }, desktopHostDeadlines.stop);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      if (this.current === launch) this.current = undefined;
    }
  }
}
