# Terminal 工作分支验证记录

基线：`main@f48da53dd842e2176fdb3f2cfee96721a9d723fd`。实施分支：`feat/terminal-workbench`。已再次查询远端 main，基线未移动。本地实际运行使用 Node 24.22.3；Linux 发行仍固定 Node 24.21.0。

## 已取得的证据

| 验证 | 结果与证明范围 |
| --- | --- |
| `node --import tsx --test --test-concurrency=1 tests/terminal*.test.ts` | 39 通过，无失败或跳过。包括真实 PTY、真实 HTTP/WS、真实 Git，以及确定性进程边界替身的竞态/超时检查。 |
| `native-bash-control-sdk`、`git-workbench`、`session-forks`、`workspace-location` 四组测试 | 18 通过、1 个既有跳过。原生 Bash 用例使用真实锁定 SDK 和本地回环模型，覆盖同目录会话的控制和真实回执；未请求付费模型。 |
| 前端纯状态、路由与目标 | 7 通过。已纳入默认 `test:frontend` 文件匹配范围。 |
| 架构、Query、i18n、UI 语义 | 通过各自 `node --import tsx scripts/check-*.mts` 入口；UI self-test 也通过。 |
| TypeScript | 服务端、前端、desktop、tools 四个配置检查通过。 |
| 前端构建 | Markdown 的 Vite/tsc、`node --import tsx scripts/build-css-types.mts`（在 markdown 包目录）、preview 资源准备，以及前端 Vite 构建通过。 |
| 桌面构建 | `node --import tsx scripts/build-desktop.mts` 通过。 |
| staged Terminal 依赖探针 | 实际 Node 24.22.3 执行目标 node-pty，验证 TTY/cwd、91×37 kernel PTY 尺寸、退出码、headless 屏幕恢复、WS 回环。只证明依赖子集，不是完整安装件。 |

39 项 Terminal 测试中，工作树用例覆盖普通目录、linked worktree、in_place 开发会话、目录替换和归属变化。持有 terminal reservation 时真实 stage/commit 可用，回收被阻止，释放后正常回收。API 用例覆盖配对/CSRF/Origin、创建重试、客户端执行参数拒绝、归档/删除保护、一次性票据、真实 shell Unicode 输出及同一 shell 重连。

## 集成审查

独立只读审查指出并推动修正：

- in_place 开发会话也必须传实际 workspace ID，只有普通未绑定开发工作区的会话使用 null。
- Browser/Terminal 互相切换后，收起应回到经过白名单校验的背景内容；保留原有可前进重开的历史语义。
- 服务端 `TERMINAL_CLOSED` 应释放客户端资源；仅有本地缓存的失联实例不能永久占用客户端名额。连接中的隐藏终端继续保留。
- 慢创建期间列表里的 `creating` 状态不能申请附着，应在准备完成后建立客户端。
- 空态与非空态各保持一个新建入口，烟测使用同一唯一按钮。
- 应用关闭必须消费终端清理报告，未观察到退出时传播失败；所有资源所有者仍等待完成后再关数据库。

缓存修复另用实际客户端源码与受控 DOM/xterm/transport 边界替身复现：关闭后 8 个实例全部释放；失联/被替换时只回收无视图实例；8 个仍连接的隐藏实例全部保留。这是控制逻辑证据，不替代真实浏览器解析器验收。

## 原始门禁与环境阻塞

`npm run check` 和 `npm run build` 的原命令均实际执行过，在 markdown 构建末尾的 tsx CLI 创建 Unix IPC socket 时以 `listen EPERM` 退出。相同 TypeScript 脚本经 `node --import tsx` 可以运行，上表据此区分原命令结果和实际子项结果。

原始 main 的隔离 worktree 全量 `npm test` 已运行至 600 秒超时。本分支原命令由 `timeout 240 npm test` 执行，同样未完成并返回 124；超时后仍有未完成的测试文件。因此没有全量门禁通过结果，不以聚焦测试代替完整门禁。

`node --import tsx scripts/smoke-terminal.mts` 已实际调用。Electron 45.4.1 在创建单实例 Unix socket 时遇到 `EPERM` 后中止，未进入可验证窗口。环境同时没有可用 Xvfb；Chromium 启动脚本存在，但目标二进制缺失。前端两项浏览器回归也在启动浏览器时失败。已在 PR 工作流加入 Xvfb 和独立 Electron 烟测，以及隔离截图/回执留存，远端结果需单独记录。

Linux packager 的实际调用因缺少 `makepkg` 退出；安装态 smoke 因 `/opt/atelier/atelier` 不存在退出。尚未构建或验收完整的 Node 24.21.0 Linux 安装件，也未重新生成 Windows/macOS 候选。系统 IME 与真实桌面全屏 TUI 仍待验收。

## GitHub 交接与 CI 结果

实现已推送为 `17252bad04b89c566ae9579335924f974e7a8f26`，远端 tree 与本地已核对源码完全一致。草稿 [PR #3](https://github.com/CoderLambert/atelier-handoff/pull/3) 目标为 `main@f48da53d`，GitHub 确认无合并冲突。整分支文件头检查覆盖 62 份源码并通过。

[Actions run 45693929946](https://github.com/CoderLambert/atelier-handoff/actions/runs/45693929946) 的首次运行和一次重试均在分配 runner 前失败：`runner_id=0`，步骤列表为空，没有可下载日志。因此没有实际执行远端测试或 Electron 烟测。现有返回信息不能确定平台失败的具体原因；需要恢复可执行的 runner 后复跑，不能将该失败推断为源码测试失败或宣称 CI 通过。PR 保持草稿，未合并和切换用户桌面。

## 复跑

```sh
npm ci
npm run check
npm test
npm run build
npm run build:desktop
node node_modules/electron/install.js
xvfb-run -a node --import tsx scripts/smoke-terminal.mts
```

发行验收沿用 README 的固定 Node/Shunt 与 Arch 工具要求，构建实际包后运行 `scripts/smoke-linux.mts` 的安装态入口。开发态烟测和安装态 p1 共用 `scripts/p1-smoke/terminal.mts`，但分别记录结果。

本机原始日志位于 `.local/terminal-workbench/`：`terminal-final-tests.log`、`main-compatibility.log`、`check.log`、`build.log`、`frontend-build.log`、`build-desktop.log`、`npm-test.log`、`electron-smoke.log`、后端/前端/打包报告及独立审查报告。该目录不进入 Git。
