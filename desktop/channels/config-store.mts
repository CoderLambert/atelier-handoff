/**
 * @file 持久化外部通道的非敏感配置（启停状态、Bot 用户名与推送开关）。
 * @implementation 使用原子写盘保存 channels-config.json，确保应用重启后自动恢复通道开关与配置。
 * @updated 2026-11-28T10:35:00+08:00
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChannelId } from '../../shared/channels.js';

export interface StoredChannelConfig {
  enabled: boolean;
  botUsername: string | null;
  pushScheduleResults: boolean;
}

const DEFAULT_CHANNEL_CONFIG: StoredChannelConfig = {
  enabled: false,
  botUsername: null,
  pushScheduleResults: false,
};

interface ConfigFile {
  formatVersion: 1;
  channels: Partial<Record<ChannelId, StoredChannelConfig>>;
}

const CONFIG_FILENAME = 'channels-config.json';

export class ChannelConfigStore {
  private cache: Partial<Record<ChannelId, StoredChannelConfig>> = {};
  private loaded = false;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly profileDir: string) {}

  private filePath(): string {
    return join(this.profileDir, CONFIG_FILENAME);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<ConfigFile>;
      if (
        parsed &&
        parsed.formatVersion === 1 &&
        parsed.channels &&
        typeof parsed.channels === 'object'
      ) {
        this.cache = { ...parsed.channels };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[channels] Failed to read channel config; using defaults.', error);
      }
    }
    this.loaded = true;
  }

  get(channel: ChannelId): StoredChannelConfig {
    const entry = this.cache[channel];
    return {
      enabled: entry?.enabled === true,
      botUsername: entry?.botUsername ?? null,
      pushScheduleResults: entry?.pushScheduleResults === true,
    };
  }

  async update(
    channel: ChannelId,
    patch: Partial<StoredChannelConfig>,
  ): Promise<StoredChannelConfig> {
    if (!this.loaded) await this.load();
    return this.serialize(async () => {
      const next: StoredChannelConfig = {
        ...this.get(channel),
        ...patch,
      };
      this.cache[channel] = next;
      await this.persist();
      return next;
    });
  }

  private async persist(): Promise<void> {
    await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
    const target = this.filePath();
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    const payload: ConfigFile = { formatVersion: 1, channels: this.cache };
    try {
      await writeFile(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work, work);
    this.pending = next.catch(() => undefined);
    return next;
  }
}
