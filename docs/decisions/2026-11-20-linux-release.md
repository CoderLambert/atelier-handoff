# P1 Linux x64 发行样包

日期为 2026-11-20。P1 采用固定版本 Electron 发行目录、编译后的 Node sidecar 与系统 makepkg。适用范围为本机 Arch/Omarchy x86_64 样包和便携归档。此前路线图将 Forge 列为首选，本记录补充实施时的取舍。下列同类项目源码比较属于实现后的复核。

## 问题与证据

旧入口要求从源码目录执行 npm、Node 和 tsx。桌面样包要能从系统菜单启动，随包提供 Node 24.21.0、SDK/CLI、SQLite、前端和 PDF worker。在独立数据根里验证新项目、离线重开与退出。目标机已有 Arch 包管理器，打包机可用 makepkg、pacman、bsdtar、zstd 和已锁定的 Electron。

## 调研与选择

| 方案与证据 | 可复用做法 | atelier 的选择 |
|---|---|---|
| [Electron Forge build lifecycle](https://www.electronforge.io/core-concepts/build-lifecycle) | 将资源组装、产生系统包和发布划成三个步骤 | 采用这些阶段及验收划分。P1 只交付本地 Arch 包和归档，平台增加时重新评估 maker。 |
| [Proma 的 electron-builder 配置](https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/electron-builder.yml) | 明确 files、extraResources、原生二进制与 ASAR 的边界，按平台配置 Linux AppImage/deb 等目标 | 借鉴资源清单和可执行文件分发策略。atelier 当前需要 Arch 原生包，使用普通目录承载可独立启动的 sidecar。 |
| [DLYZZT/pi-desktop 的构建配置](https://github.com/DLYZZT/pi-desktop/blob/ec7ecc14005f8a47ab214a7bc901a77549f404a7/electron-builder.yml) | shell 和 agent host 使用独立资源，按目标平台选择要带的文件 | 对齐宿主和运行资源分离，不沿用它的目录名、进程协议或安装件策略。 |
| [Arch makepkg](https://man.archlinux.org/man/makepkg.8.en) | 普通用户生成可由 pacman 管理的包，PKGBUILD 声明依赖、安装布局与入口 | P1 采用。安装入口、版本、系统依赖、归档文件模式和资源哈希可直接核验。代价是项目自行维护 staging、锁文件和许可证清单。 |

## 验证与回退

`npm run package:linux` 先执行类型/架构检查和前端构建，再核对运行时闭包、资源哈希及归档清单。`npm run smoke:linux` 从交付的可执行文件启动，使用独立的测试项目、显示、数据目录和 profile。实际结果和首版预算记在[执行日志](../../openspec/roadmaps/build-atelier-desktop/task-log.md)。样包按独立数据根试用。跨平台发布、签名或资源准备的维护成本显著增加时，重新比较 Forge 和 electron-builder。P1 未覆盖的上游许可文本在对外分发前复核。

## MCP 后续调研入口

若下一阶段变更 MCP 连接的生命周期或权限，应重新核对所用 SDK 版本，并沿同类系统的两条调用链读源码。Proma 的 `listTools` 与 `callTool` 经同一连接管理器，配置摘要参与连接身份。这里可借鉴恢复与释放的职责，但是否重试须按操作的副作用判断。[Proma pi-mcp-tools.ts](https://github.com/proma-ai/Proma/blob/86d9dfb511db4c1e3ffded3b6c3e312996f50cbf/apps/electron/src/main/lib/adapters/pi-mcp-tools.ts)

DLYZZT/pi-desktop 将发现等待与授权请求分开，发现支持有界等待/取消，审批完成后再检查当前状态。本仓讨论同类能力时，需要与项目级授权、智能体范围及逐次审批共同对照。这两项源码阅读是调研示例，尚未在本轮运行外部项目。[发现](https://github.com/DLYZZT/pi-desktop/blob/ec7ecc14005f8a47ab214a7bc901a77549f404a7/src/agent-host/mcp/discovery.ts) · [授权](https://github.com/DLYZZT/pi-desktop/blob/ec7ecc14005f8a47ab214a7bc901a77549f404a7/src/agent-host/mcp/authorization.ts)
