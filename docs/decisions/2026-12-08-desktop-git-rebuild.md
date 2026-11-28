# 开发桌面随 Git 检出更新重建

目前 `npm run desktop` 只在启动前执行类型检查、前端构建和桌面构建。用户拉取分支后，希望开发窗口打开期间也自动构建。重建的触发条件是当前工作树的 `HEAD` 变化，包括快进、合并、rebase 和切分支。仅更新远端跟踪引用与重复拉取相同提交不会触发。

[Git hooks 文档](https://git-scm.com/docs/githooks)中的 post-merge、post-rewrite 和 post-checkout 可以覆盖部分入口，但组合使用需要配置 Git hooks、处理现有 hooks 和 Git 工作树共享设置。[git rev-parse 文档](https://git-scm.com/docs/git-rev-parse)提供当前提交和工作树自己的 Git 目录。采用由 npm 启动器持有的串行轮询。只在相邻两次观察得到相同提交且检出没有合并、rebase 或索引写入时启动重建。后续提交由下一次轮询拾取。Electron 进程退出后结束轮询。

保留已有 npm 构建步骤和 Electron 入口。按本仓库锁定的 Electron 45.4.1 的 `cli.js` 核对了二进制定位、参数透传和退出方式。开发启动与重建使用 [Vite emptyOutDir](https://vite.dev/config/build-options#build-emptyoutdir) 保留当前窗口可能还需要的哈希 chunk，下次启动加载完整新版本。构建失败在终端报告，并等待下一个提交或手动构建。避免自动重启带来的运行中断。发布构建继续使用原来的输出目录清理规则。

验证时先用临时 Git 仓库和启动替身核对拉取、无变化、构建失败恢复和退出，再在隔离数据目录中使用真实 Electron 和实际构建。回退时恢复原 `desktop` 和 `predesktop` 脚本即可。

## 开发窗口关闭之后的启动

实机复现了已打开最小化到托盘的旧窗口在关闭后继续持有 Electron 单实例锁。此时执行启动命令会构建成功、唤回原窗口，随后结束第二个进程。根据 [Electron 单实例锁与退出事件](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata)，保留正常的单实例唤回和 `app.quit()` 退出流程。由 npm 启动器只为开发窗口标记启动来源，使窗口关闭时走原有退出路径，释放运行时锁。遇到已运行实例时打印退出重开的方式。已保存的托盘偏好继续用于普通桌面启动与发行版。使用打开托盘偏好的隔离 profile 核对关闭、锁释放和再次启动。

## 成功构建后自动应用

启动器在构建成功后通过私有子进程 IPC 请求重启。Electron 继续持有窗口，并通过既有的私有运行时通道请求退出许可。SQLite 有活动运行、终端有活动进程或写请求在途时，运行时暂缓接受。批准时同时停止接收新任务。Electron 持有人工网页接管或网页工具操作时也会暂缓。正常退出完成后，由同一 npm 启动器沿用原数据、浏览器 profile 和实际端口启动新构建，继续监听后续拉取。构建失败保留当前实例，手动退出仍会结束启动器。

[Node 子进程 IPC](https://nodejs.org/api/child_process.html)与[Electron 的退出和 relaunch](https://www.electronjs.org/docs/latest/api/app#apprelaunchoptions)提供了两种边界。用小型隔离 Electron 进程确认了直接启动二进制可以双向通信。Electron 自行 relaunch 会脱离原 npm 启动器，后续拉取便失去监听。采用启动器拥有重启的方案，Electron 沿用现有的退出和运行时写盘流程。回退时可以恢复只重建的启动器和退出策略。没有新增网络接口或 SQLite 数据格式。开发窗口的可信页面改用[持久 Electron 分区](https://www.electronjs.org/docs/latest/api/structures/web-preferences)，配合同一端口保留本地草稿和设置。已打开的旧版内存分区不能在首次切换时继承。
