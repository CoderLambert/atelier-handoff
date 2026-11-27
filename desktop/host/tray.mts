/**
 * @file 管理系统托盘图标、右键菜单与关闭最小化行为。
 * @implementation 使用内嵌 PNG 创建原生托盘，按语言与偏好动态刷新菜单，并在托盘不可用时安全降级。
 * @updated 2026-11-27T23:50:00+08:00
 */
import { Menu, Tray, nativeImage } from 'electron';
import { desktopT } from './i18n.mjs';
import {
  TRAY_ICON_PNG_BASE64,
  shouldHideWindowOnClose,
  shouldKeepAliveWhenWindowsClosed,
} from './tray-policy.mjs';

export interface DesktopTrayOptions {
  isMinimizeToTrayEnabled: () => boolean;
  onToggleMinimizeToTray: (enabled: boolean) => void;
  onShowWindow: () => void;
  onQuit: () => void;
}

function createTrayIcon() {
  const image = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, 'base64'));
  return process.platform === 'darwin' ? image.resize({ width: 18, height: 18 }) : image;
}

export class DesktopTrayController {
  private tray: Tray | undefined;

  constructor(private readonly options: DesktopTrayOptions) {
    try {
      const tray = new Tray(createTrayIcon());
      tray.on('click', () => this.options.onShowWindow());
      tray.on('double-click', () => this.options.onShowWindow());
      this.tray = tray;
      this.refreshMenu();
    } catch (error) {
      console.warn('System tray unavailable; close-to-tray disabled.', error);
      this.tray = undefined;
    }
  }

  isAvailable(): boolean {
    return this.tray !== undefined && !this.tray.isDestroyed();
  }

  shouldHideOnClose(stopping: boolean, quitting: boolean): boolean {
    return shouldHideWindowOnClose({
      stopping,
      quitting,
      trayAvailable: this.isAvailable(),
      minimizeToTrayOnClose: this.options.isMinimizeToTrayEnabled(),
    });
  }

  shouldKeepAliveOnAllClosed(stopping: boolean, quitting: boolean): boolean {
    return shouldKeepAliveWhenWindowsClosed({
      stopping,
      quitting,
      trayAvailable: this.isAvailable(),
      minimizeToTrayOnClose: this.options.isMinimizeToTrayEnabled(),
    });
  }

  refreshMenu(): void {
    if (!this.isAvailable() || !this.tray) return;
    this.tray.setToolTip(desktopT('host.tray.tooltip'));
    const menu = Menu.buildFromTemplate([
      {
        label: desktopT('host.tray.show'),
        click: () => this.options.onShowWindow(),
      },
      {
        label: desktopT('host.tray.minimizeToTray'),
        type: 'checkbox',
        checked: this.options.isMinimizeToTrayEnabled(),
        click: (item) => {
          this.options.onToggleMinimizeToTray(item.checked);
        },
      },
      { type: 'separator' },
      {
        label: desktopT('host.tray.quit'),
        click: () => this.options.onQuit(),
      },
    ]);
    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) {
      this.tray.destroy();
    }
    this.tray = undefined;
  }
}
