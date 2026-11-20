# Windows 与 macOS 候选包

P8 和 P9 要把已验证的工作台装进目标平台的 Electron 发行版，并验证安装、升级和退出。当前构建环境是 Linux x64。已通过发行元数据和 lockfile 找到 Electron 45.4.1、Node 24.21.0 和 SDK 0.3.326 的 Windows x64 与 macOS arm64 工件。现有 Linux 运行时依赖只有 SDK CLI 是平台二进制。Node 自带 SQLite。

## 取舍

- Electron 官方公布未归档应用的目录布局。Electron Packager 的 Windows 实现支持替换 Electron 应用名，macOS 实现负责更新 `Info.plist` 和各 Helper 名称。将可移植的应用代码和运行时文件交给 Packager，在 `extraResource` 中放入配套 Node 和 CLI。Packager 锁定版本，Windows 和 macOS 用官方发行 ZIP。[目录布局](https://www.electronjs.org/docs/latest/tutorial/application-distribution) · [Packager Options](https://electron.github.io/packager/main/interfaces/Options.html) · [Windows 实现](https://github.com/electron/packager/blob/v20.3.0/src/win32.ts) · [macOS 实现](https://github.com/electron/packager/blob/v20.3.0/src/mac.ts)
- 直接手工替换 macOS 主进程和 Helper 的名称会重复 Packager 的平台逻辑。Linux 验收包可以提供已筛选的 JS 和客户端资源。复制前校验资源清单中的内容，换入与目标平台对应的官方二进制和许可。目标二进制用上游 SHA-256 或依赖 lockfile 的 SHA-512 核对。
- 安装和签名留在对应系统核验。Windows 在真实系统上检查安装、重开、进程清理和平台沙箱能力描述。macOS 在真实系统上检查原生菜单、关闭重开、登录与公证。应用与工作区组件的许可由权利人确认，对外分发另外取得用户授权。

## 验证与回退

本轮在 Linux 各生成一份 Windows x64 与 macOS arm64 ZIP，验证归档、目标架构和随包资源。脚本 `scripts/package-platform-preview.mts` 接收目标、已下载的发行输入路径和安装了 `@electron/packager@20.3.0` 的独立 npm 前缀。输入 ZIP 和 tar 的准确名称及身份校验值在脚本里。输出放在 `dist/platform-previews/`，各候选归档按其 `acceptance.json` 核对。

当前开发优先 Linux。之后在目标系统验收时，使用隔离数据根运行 `scripts/smoke-desktop-recovery.mts`，并走项目、会话和配置的旧包到新包切换。Linux 与跨平台候选各用独立输出目录。失败时保留当前已通过验收的 Linux 工件及用户数据。
