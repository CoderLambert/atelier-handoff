import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import { AppError } from '../shared/types.js';

export function pickProjectDirectory(signal: AbortSignal): Promise<string | null> {
  if (process.platform !== 'linux' || !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    throw new AppError('PROJECT_PICKER_UNAVAILABLE', '当前服务没有可用的 Linux 桌面会话，请手动输入目录路径。', 503);
  }
  const env = Object.fromEntries(['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY', 'HOME', 'LANG', 'LC_ALL', 'LC_MESSAGES'].map(key => [key, process.env[key]]));
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/zenity', [
      '--file-selection', '--directory', '--title=选择 atelier 项目目录', `--filename=${homedir()}${sep}`,
    ], { env, signal, timeout: 300_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 1 && !stdout && !/cannot open display|failed to initialize/i.test(stderr)) return resolve(null);
        return reject(new AppError('PROJECT_PICKER_UNAVAILABLE', '系统目录选择框未能完成，请手动输入目录路径。', 503));
      }
      const path = stdout.replace(/\n$/, '');
      if (!isAbsolute(path)) return reject(new AppError('INVALID_PROJECT_SELECTION', '系统未返回有效目录，请手动输入路径。'));
      resolve(path);
    });
  });
}
