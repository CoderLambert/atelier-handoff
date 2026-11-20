/**
 * @file 管理 Linux 桌面包所含的 Shunt 进程和持久配置。
 * @implementation 复用持久账户目录，以系统分配的回环端口启动网关，并在工作台退出时关闭所属进程。
 * @updated 2026-11-20T17:30:00+08:00
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const initialConfig = `[server]
bind = "127.0.0.1:0"
default_provider = "chatgpt-plan"
shutdown_timeout_seconds = 2

[server.auth]
tokens_env = "ATELIER_SHUNT_CLIENT_TOKENS"

[providers.chatgpt-plan]
kind = "responses"
base_url = "https://api.openai.com/v1"
auth = "chatgpt_plan_oauth"

[[routes]]
model = "gpt-6.1-sol"
provider = "chatgpt-plan"
`;

async function createOnce(path: string, contents: string): Promise<void> {
  try {
    await writeFile(path, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export interface ManagedShuntConnection {
  origin: string;
  token: string;
  binary: string;
  configPath: string;
  accountsDirectory: string;
}

export class ManagedShunt {
  private process?: { child: ChildProcess; exited: Promise<void> };
  private connection?: ManagedShuntConnection;

  constructor(
    readonly binary: string,
    private readonly workspace: string,
  ) {}

  async start(signal: AbortSignal): Promise<ManagedShuntConnection> {
    signal.throwIfAborted();
    if (
      this.connection &&
      this.process?.child.exitCode === null &&
      this.process.child.signalCode === null
    )
      return this.connection;
    await this.stop();
    const directory = join(this.workspace, 'shunt');
    const configPath = join(directory, 'shunt.toml');
    const profilePath = join(directory, 'accounts-path');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await createOnce(configPath, initialConfig);
    const explicit = process.env.SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR;
    const defaultDirectory = join(homedir(), '.shunt/accounts/chatgpt-plan');
    let accountDirectory: string;
    try {
      accountDirectory = (await readFile(profilePath, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const entries = await readdir(defaultDirectory, { withFileTypes: true }).catch(() => []);
      accountDirectory =
        explicit?.trim() ||
        (entries.some((entry) => entry.isFile() && entry.name.endsWith('.json'))
          ? defaultDirectory
          : join(directory, 'accounts/chatgpt-plan'));
      if (!isAbsolute(accountDirectory)) throw new Error('Shunt 账号目录必须使用绝对路径。');
      await createOnce(profilePath, `${accountDirectory}\n`);
      accountDirectory = (await readFile(profilePath, 'utf8')).trim();
    }
    if (!isAbsolute(accountDirectory)) throw new Error('Shunt 账号目录必须使用绝对路径。');
    await mkdir(accountDirectory, { recursive: true, mode: 0o700 });
    signal.throwIfAborted();
    const token = randomBytes(32).toString('hex');
    const child = spawn(this.binary, ['run', '--config', configPath], {
      cwd: directory,
      env: {
        ...process.env,
        SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR: accountDirectory,
        ATELIER_SHUNT_CLIENT_TOKENS: `atelier:${token}`,
        RUST_LOG: 'shunt=info',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const exited = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
    });
    this.process = { child, exited };
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
    const lines = createInterface({ input: child.stderr });
    let pendingError: ((reason: Error) => void) | undefined;
    child.on('error', () => pendingError?.(new Error('无法启动包内 Shunt。')));
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        pendingError = reject;
        const abort = () => reject(new Error('内置 Shunt 启动超时。'));
        timeout.addEventListener('abort', abort, { once: true });
        lines.once('close', () => {
          timeout.removeEventListener('abort', abort);
          reject(new Error('内置 Shunt 未成功绑定回环端口。'));
        });
        lines.on('line', (line) => {
          const port = Number(/shunt listening\s+local_addr=127\.0\.0\.1:(\d+)/u.exec(line)?.[1]);
          if (Number.isInteger(port) && port > 0 && port <= 65535) {
            timeout.removeEventListener('abort', abort);
            resolve(`http://127.0.0.1:${port}`);
          }
        });
      });
      const health = await fetch(`${origin}/health`, { signal: timeout });
      if (!health.ok) throw new Error('内置 Shunt 健康检查未通过。');
      this.connection = {
        origin,
        token,
        binary: this.binary,
        configPath,
        accountsDirectory: accountDirectory,
      };
      return this.connection;
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      pendingError = undefined;
      lines.close();
      child.stderr.resume();
    }
  }

  async stop(): Promise<void> {
    const running = this.process;
    this.process = undefined;
    this.connection = undefined;
    if (!running) return;
    if (running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill('SIGTERM');
      const abort = new AbortController();
      try {
        await Promise.race([
          running.exited,
          delay(2500, undefined, { signal: abort.signal }).then(() =>
            running.child.kill('SIGKILL'),
          ),
        ]);
      } finally {
        abort.abort();
      }
    }
    await running.exited;
  }
}
