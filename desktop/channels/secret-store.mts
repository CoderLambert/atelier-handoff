/**
 * @file 基于 Electron safeStorage 加密持久化外部通道 Bot Token。
 * @implementation 严格校验系统加密能力，仅将 base64 密文原子写入 profile 目录下的 0600 权限文件，禁止明文落盘。
 * @updated 2026-11-28T10:35:00+08:00
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChannelId } from '../../shared/channels.js';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface EncryptedSecretsFile {
  formatVersion: 1;
  secrets: Partial<Record<ChannelId, string>>;
}

const SECRETS_FILENAME = 'channel-secrets.json';

export class ChannelSecretStore {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly profileDir: string,
    private readonly storage: SafeStorageLike,
  ) {}

  private filePath(): string {
    return join(this.profileDir, SECRETS_FILENAME);
  }

  private assertEncryptionAvailable(): void {
    if (!this.storage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法加密保存 Bot Token。');
    }
  }

  private async readMap(): Promise<Partial<Record<ChannelId, string>>> {
    try {
      const raw = await readFile(this.filePath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<EncryptedSecretsFile>;
      if (
        parsed &&
        parsed.formatVersion === 1 &&
        parsed.secrets &&
        typeof parsed.secrets === 'object'
      ) {
        return { ...parsed.secrets };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[channels] Failed to read encrypted channel secrets:', error);
      }
    }
    return {};
  }

  private async writeMap(secrets: Partial<Record<ChannelId, string>>): Promise<void> {
    await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
    const target = this.filePath();
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    const payload: EncryptedSecretsFile = { formatVersion: 1, secrets };
    try {
      await writeFile(temp, JSON.stringify(payload), { mode: 0o600 });
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

  async getToken(channel: ChannelId): Promise<string | null> {
    const map = await this.readMap();
    const encoded = map[channel];
    if (!encoded) return null;
    this.assertEncryptionAvailable();
    try {
      const decrypted = this.storage.decryptString(Buffer.from(encoded, 'base64')).trim();
      return decrypted || null;
    } catch {
      return null;
    }
  }

  async setToken(channel: ChannelId, token: string): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error('Bot Token 不能为空。');
    this.assertEncryptionAvailable();
    const encrypted = this.storage.encryptString(trimmed).toString('base64');
    await this.serialize(async () => {
      const map = await this.readMap();
      map[channel] = encrypted;
      await this.writeMap(map);
    });
  }

  async deleteToken(channel: ChannelId): Promise<void> {
    await this.serialize(async () => {
      const map = await this.readMap();
      if (!(channel in map)) return;
      delete map[channel];
      await this.writeMap(map);
    });
  }
}
