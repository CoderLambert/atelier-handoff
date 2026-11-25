/**
 * @file 定义随包 RTK OSS 的固定资源身份和启动器。
 * @implementation 共享发布归档、二进制及许可证摘要。启动器隔离 RTK 状态并保留被包装工具的 XDG 环境，清理继承的 RTK 覆盖变量。
 * @updated 2026-11-26T03:01:01+08:00
 */
export const rtkRelease = {
  name: 'rtk-oss',
  version: '1.2.1',
  platform: 'linux',
  arch: 'x64',
  target: 'x86_64-unknown-linux-musl',
  resourcePath: 'rtk/rtk',
  launcherPath: 'rtk/bin/rtk',
  license: 'Apache-2.0',
  attribution: 'Copyright 2026 RTK AI Labs',
  binarySha256: 'e2950ef652b7e5af115b4573d19ca329a6ee2af758ccaa1de67d5d308694ada0',
  archiveSha256: '44aa460c4827d206d11405c652832c9f7082edccfbc3a9f15a69a851e8a9e8b4',
  licenseSha256: '33f694a31d9f9df3e292a9413a3cdb0113fa72698e2c719f657ff6b53165dcc4',
  source: {
    repository: 'https://github.com/rtk-ai/rtk',
    tag: 'v1.2.1',
    commit: 'd0f0399a5ff8cd1d81325a033f0b2d8864d665f6',
    archive:
      'https://github.com/rtk-ai/rtk/releases/download/v1.2.1/rtk-oss-x86_64-unknown-linux-musl.tar.gz',
    checksums: 'https://github.com/rtk-ai/rtk/releases/download/v1.2.1/checksums.txt',
  },
} as const;

/** Isolate RTK state without replacing the wrapped tool's XDG paths. */
export const rtkLauncher = `#!/bin/sh
case "\${ATELIER_RTK_HOME-}" in
  /*) ;;
  *) printf '%s\\n' 'ATELIER_RTK_HOME must be an absolute application data path.' >&2; exit 64 ;;
esac
case "\${1-}" in
  --atelier-exec) shift ;;
  git|bypass) ;;
  *)
    XDG_CONFIG_HOME="$ATELIER_RTK_HOME/config"
    XDG_DATA_HOME="$ATELIER_RTK_HOME/data"
    XDG_CACHE_HOME="$ATELIER_RTK_HOME/cache"
    export XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME
    ;;
esac
RTK_DB_PATH="$ATELIER_RTK_HOME/tracking.sqlite" \\
RTK_NO_TOML=1 \\
RTK_TELEMETRY_DISABLED=1 \\
RTK_TEE=0 \\
RTK_RECALL=0 \\
RTK_SUPPRESS_HOOK_WARNING=1 \\
exec "\${0%/*}/../rtk" "$@"
`;

/** Inherited RTK paths/configuration must never select the application's resources. */
export function clearRtkEnvironment(environment: Record<string, string | undefined>): void {
  for (const key of Object.keys(environment)) {
    if (/^(?:RTK_|ATELIER_RTK_|ATELIER_BUILD_RTK(?:_|$))/.test(key)) delete environment[key];
  }
}
