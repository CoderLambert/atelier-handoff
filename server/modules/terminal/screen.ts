/**
 * @file 持有人工终端的有界 headless 屏幕。
 * @implementation 使用同代 xterm 与 SerializeAddon 恢复屏幕；查询应答仅由附着客户端负责。
 * @updated 2026-11-26T01:00:00+08:00
 */
import headless from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { terminalLimits } from '../../../shared/terminal.js';

export class TerminalScreen {
  private readonly terminal: InstanceType<typeof headless.Terminal>;
  private readonly serializer = new SerializeAddon();
  constructor(cols: number, rows: number) {
    this.terminal = new headless.Terminal({
      cols,
      rows,
      scrollback: terminalLimits.scrollback,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.serializer);
  }
  write(data: string): Promise<void> {
    return new Promise((resolve) => this.terminal.write(data, resolve));
  }
  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }
  serialize(): string {
    return this.serializer.serialize();
  }
  dispose(): void {
    this.terminal.dispose();
  }
}
