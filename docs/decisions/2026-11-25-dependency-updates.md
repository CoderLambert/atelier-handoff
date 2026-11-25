# 依赖更新和 PR 检查

Atelier 用 npm 精确锁定根应用与 Markdown 工作区的依赖。更新范围会影响 Electron、原生 CLI、测试和安装件，现有 OpenWiki 工作流只负责文档更新。这次增加每周扫描和独立的 PR 验证，并保留用户手动维护文件预览及其渲染依赖的入口。

## 自动更新

GitHub Dependabot 支持定时检查和分组。此处沿用已选的 Renovate，其 npm 管理器可更新精确版本与共享锁文件，Dependency Dashboard 可以让 Electron、SDK、原生依赖和大版本进入审批队列。配置只检查根清单和 Markdown 工作区清单。确定的前端补丁按组提 PR，合并由仓库维护者执行。Node 类型限制在发行使用的 24.x，文件预览、PDF、表格及 Markdown 渲染器由用户单独更新，关掉整份锁文件自动刷新。

- [Renovate npm 管理器](https://docs.renovatebot.com/modules/manager/npm/)
- [Renovate 配置](https://docs.renovatebot.com/configuration-options/)
- [Dependabot 分组与冷却期](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)

## PR 验证

在 GitHub 托管的 Ubuntu 24.04 x64 使用发行基线 Node 24.21.0 和锁文件执行 npm ci。复用现成的单元及集成测试、真实 SDK 回环夹具和浏览器交互测试，按同一 job 运行类型检查、测试、前端和桌面构建。Chrome 和命令沙箱在测试前检查。Ubuntu 需要 AppArmor 时，仅加载发行版提供的 bubblewrap 配置。一次性 runner 补齐 Arch 命令沙箱预期的加载器路径，继续使用应用原有的隔离参数。安装件和真实 Electron 会话仍由 Linux 安装态入口验证。

工作流使用只读仓库权限，并为同一 PR 取消已过期的运行。GitHub 要求必过检查时，PR 即使只改配置也应产生同名检查，因此触发器覆盖每个 PR。首次远端运行成功后，可把 GitHub 显示的 Linux x64 checks 加为默认分支的必过检查。

- [GitHub Node.js 工作流](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)
- [GitHub 必过检查与过滤](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
- [Ubuntu 24.04 AppArmor 包清单](https://packages.ubuntu.com/noble-updates/all/apparmor-profiles/filelist)

回退补丁批次时一并恢复依赖清单和锁文件。停用自动化时撤销该仓库的 Renovate App 授权，若 CI 已被设为必过，先调整分支规则再删除工作流。
