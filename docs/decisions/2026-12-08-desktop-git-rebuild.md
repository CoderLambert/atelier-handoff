# 开发桌面随 Git 检出更新重建

目前 `npm run desktop` 只在启动前执行类型检查、前端构建和桌面构建。用户拉取分支后，希望开发窗口打开期间也自动构建。重建的触发条件是当前工作树的 `HEAD` 变化，包括快进、合并、rebase 和切分支。仅更新远端跟踪引用与重复拉取相同提交不会触发。

[Git hooks 文档](https://git-scm.com/docs/githooks)中的 post-merge、post-rewrite 和 post-checkout 可以覆盖部分入口，但组合使用需要配置 Git hooks、处理现有 hooks 和 Git 工作树共享设置。[git rev-parse 文档](https://git-scm.com/docs/git-rev-parse)提供当前提交和工作树自己的 Git 目录。采用由 npm 启动器持有的串行轮询。只在相邻两次观察得到相同提交且检出没有合并、rebase 或索引写入时启动重建。后续提交由下一次轮询拾取。Electron 进程退出后结束轮询。

保留已有 npm 构建步骤和 Electron 入口。按本仓库锁定的 Electron 45.4.1 的 `cli.js` 核对了二进制定位、参数透传和退出方式。开发启动与重建使用 [Vite emptyOutDir](https://vite.dev/config/build-options#build-emptyoutdir) 保留当前窗口可能还需要的哈希 chunk，下次启动加载完整新版本。构建失败在终端报告，并等待下一个提交或手动构建。避免自动重启带来的运行中断。发布构建继续使用原来的输出目录清理规则。

验证时先用临时 Git 仓库和启动替身核对拉取、无变化、构建失败恢复和退出，再在隔离数据目录中使用真实 Electron 和实际构建。回退时恢复原 `desktop` 和 `predesktop` 脚本即可。
