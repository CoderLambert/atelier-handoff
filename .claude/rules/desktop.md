---
paths:
  - "desktop/**/*"
  - "shared/desktop*"
  - "server/desktop*"
  - "server/main.ts"
  - "server/extension-mcp.ts"
  - "frontend/src/app/desktop*"
  - "scripts/linux/**/*"
  - "scripts/p1-smoke/**/*"
  - "scripts/*desktop*"
  - "scripts/smoke-linux*"
  - "tsconfig.desktop.json"
  - "tsconfig.tools.json"
---

# 桌面、工具链与发行

- main 拥有原生窗口、view、profile 和子进程生命周期。preload 只暴露用途明确的类型化方法。外部网页使用独立 session 和受限 webPreferences。具体交接、输入法和缩放验证见仓库 Electron Skill。
- 为 main、preload、发行 CLI 和 smoke 编写 `.mts`、`.cts` 或 `.ts`。让 `npm run check` 在发布前覆盖每个源码入口。esbuild 负责生成 JS，tsc 负责类型检查。
- IPC 参数和回复都从共享 schema 推导。核对可信发送方、项目归属、权限和请求 ID。新建的 listener、timer、session、webContents 和子进程都要有对应的释放路径。
- 在开发态和安装态分别解析只读资源与可写数据。安装态使用随包的运行时、CLI、worker 和资源清单，路径可含空格。归档从白名单构建，保留许可证、可执行位及哈希。
- 发布 smoke 启动工件本身，使用隔离数据和 profile，记录就绪、功能结果和退出后的进程。修改安装、文件覆盖、打包路径时验收失败重试与用户已有数据的处理。
- 应用提供的原生对话框标题、按钮、提示和恢复文案使用桌面词条。Electron main 在 profile 中持有界面语言偏好，renderer 经窄 IPC 应用已保存的语言。系统提供的控件由系统本地化。详见[界面国际化决策](../../docs/decisions/2026-11-22-ui-i18n.md)。
