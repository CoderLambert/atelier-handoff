# Git 面板实时同步

右侧 Git 面板读取当前已选工作树。对话执行、其他会话和终端可在面板之外修改文件、索引和引用。既有文件状态与差异查询依赖手动刷新和面板 mutation，桌面分支状态的轮询也无法更新另外的文件列表缓存。

## 取舍

- Git 官方的 [hooks](https://git-scm.com/docs/githooks) 随特定 Git 命令运行。直接编辑文件和另一工作树的修改需要独立观察。Atelier 的受控 Git 读取已关闭仓库可执行钩子。
- [VS Code Git 扩展 repository.ts](https://github.com/microsoft/vscode/blob/8cfcc55c1513c25a9550ce261c260ef6c7683701/extensions/git/src/repository.ts#L371) 的 DotGitWatcher 和 Repository.onFileChange 分别观察 Git 元数据与检出目录，将通知合并后读取实际状态。借鉴双来源和重新读取的做法。Atelier 的文件系统能力由运行时持有。
- [GitHub Desktop app-store.ts](https://github.com/desktop/desktop/blob/35f595021b3e67d5253c8b6ad4de8871d15ea810/app/src/lib/stores/app-store.ts#L3844) 的 _refreshRepositoryAfterCommit 和 _refreshOrRecoverRepository 使用 Git 快照刷新状态。命令完成和窗口聚焦可补齐刷新，直接监听磁盘才覆盖应用之外的写入。
- [Node fs.watch](https://nodejs.org/api/fs.html#fswatchfilename-options-listener) 存在 inode 替换和平台差异。采用纯 JavaScript 的 [Chokidar 4.0.3](https://github.com/paulmillr/chokidar/tree/4.0.3)，用目录过滤排除 Git 忽略的目录和无关元数据，关闭符号链接跟随。Linux 发行清单纳入其运行时依赖和许可证。

## 实施

运行时从已绑定项目和允许读取的工作树 ID 解析 Git 根目录、工作树元数据及共享元数据。旁路 SSE 按所选工作树创建和释放监听，发送合并后的失效通知，不传文件名或内容，也不持久化。校验和读取继续走原来的运行时和桌面权限路径。工作树根目录的普通变化、实际暂存区、HEAD 和共享引用变化都会通知，索引锁与无关对象目录过滤掉。忽略规则改变时重新连接，按新的 Git 忽略目录建立监听。桌面状态查询关闭 Git 的可选索引写入，以免刷新反过来触发监听。

前端按项目刷新已有活跃查询和所选工作树对应的内容。按 SHA 固定的历史查询保持缓存，新提交通过概览更新历史起点。建立及恢复监听时重新读一次，打开且可见的面板每 15 秒校准，覆盖漏报和文件系统监听故障。关闭面板、切换工作树或退出运行时时释放资源。

## 验证与回退

用独立仓库和数据根验证正在运行的对话执行暂存与提交、其他进程写入、相同状态下的差异更新、独立工作树不混入文件、共享分支更新以及连接清理。用真实 Electron 核对文件列表和提交历史。监听受限时，定时读取和原有刷新按钮提供恢复入口。回退此变更即可回到原来的刷新机制，无迁移或仓库配置。
