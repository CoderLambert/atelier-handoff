/**
 * @file 监督独立的 Node 工作台运行时。
 * @implementation 启动私有 IPC、校验就绪握手，并按连接代次撤销与清理子进程。
 * @updated 2026-11-20T02:00+08:00
 */
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { delimiter, join } from 'node:path';
import {
  desktopHostDeadlines,
  desktopHostReplySchema,
  desktopHostVersion,
  type DesktopHostFailure,
  type DesktopHostHello,
} from '../../shared/desktop-host.js';

const failureMessage: Record<DesktopHostFailure, string> = {
  PORT_IN_USE: '工作台端口已被占用。释放端口后重试。',
  DATA_LOCKED: '工作台数据正在被其他实例使用。关闭该实例后重试。',
  DATA_PATH: '工作台数据目录不可用。请检查目录及所有者。',
  STARTUP_FAILED: '工作台服务启动失败。请查看运行日志。',
};

interface LaunchOptions {
  packaged: boolean;
  root: string;
  dataDir: string;
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
    private readonly onLost: (reason: string) => void,
  ) {}

  get connected(): boolean {
    return this.current?.ready === true && this.current.child.connected && !this.current.retired;
  }

  owns(child: ChildProcess): boolean {
    return this.current?.child === child && this.current.ready && !this.current.retired;
  }

  async start(): Promise<{ origin: string; pairing: string }> {
    if (this.current) throw new Error('工作台服务尚未停止。');
    const { root, packaged, dataDir } = this.options;
    const nodeBin = join(root, 'bin');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ATELIER_DESKTOP_BROWSER: '1',
      ATELIER_DATA_DIR: dataDir,
      ATELIER_PORT: process.env.ATELIER_PORT ?? '0',
    };
    if (packaged) {
      env.PATH = [nodeBin, process.env.PATH].filter(Boolean).join(delimiter);
      delete env.NODE_PATH;
      delete env.NODE_OPTIONS;
    }
    const child = fork(join(root, packaged ? 'server/main.js' : 'server/main.ts'), [], {
      cwd: root,
      execPath: packaged ? join(nodeBin, 'node') : process.env.npm_node_execpath || 'node',
      execArgv: packaged ? [] : ['--env-file-if-exists=.env', '--import', 'tsx'],
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
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
        const lost = (reason: string) => {
          clearTimeout(timeout);
          if (this.current !== launch || failed) return;
          failed = true;
          if (launch.ready) {
            launch.ready = false;
            this.onLost(reason);
          } else reject(new Error(reason));
        };
        const timeout = setTimeout(() => lost('工作台服务启动超时。'), desktopHostDeadlines.ready);
        launch.cancelStartup = () => lost('工作台服务启动已取消。');
        child.on('error', () => lost('无法启动或连接工作台服务。'));
        child.once('disconnect', () => lost('工作台服务连接已断开。'));
        child.once('exit', () => {
          // Descendants may still exist after an unexpected exit of their process group leader.
          if (this.current === launch) signal(child, 'SIGKILL');
          lost('工作台服务已退出。');
        });
        child.on('message', (message: unknown) => {
          if (launch.retired || failed) return;
          if (launch.ready) {
            this.onMessage(child, message);
            return;
          }
          const reply = desktopHostReplySchema.safeParse(message);
          if (!reply.success || reply.data.generation !== hello.generation) {
            lost('工作台服务协议不兼容。');
            return;
          }
          if (reply.data.type === 'atelier-host:failed') {
            lost(failureMessage[reply.data.code]);
            return;
          }
          clearTimeout(timeout);
          launch.ready = true;
          launch.cancelStartup = undefined;
          resolve(reply.data.port);
        });
        child.send(hello, (error) => {
          if (error) lost('无法建立工作台服务连接。');
        });
      });
      if (!this.owns(child) || !child.connected) throw new Error('工作台服务连接已断开。');
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
      // Ask Node to drain before terminating the entire Unix process group.
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
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
