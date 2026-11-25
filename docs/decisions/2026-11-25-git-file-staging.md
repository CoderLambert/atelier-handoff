# Git 文件暂存和快捷提交

文件变动面板已有分层状态读取和手动分组提交，但缺少逐文件写入索引的操作。快捷提交会先执行全量暂存，用户无法决定这次纳入哪些文件。左栏容器和内部列表都允许滚动，窄面板的列表高度还会被提交区和储藏区挤占。

参考 Git 的 [add](https://git-scm.com/docs/git-add)、[路径形式的 reset](https://git-scm.com/docs/git-reset) 和 [rm --cached](https://git-scm.com/docs/git-rm)。核对了 VS Code Git 扩展的 [Repository.add、revert](https://github.com/microsoft/vscode/blob/d8b0b6fc93e3027e3dae61d348d73f8b3f33c59c/extensions/git/src/repository.ts) 和 [底层 Git 调用](https://github.com/microsoft/vscode/blob/d8b0b6fc93e3027e3dae61d348d73f8b3f33c59c/extensions/git/src/git.ts)，包括首次提交前从索引移除文件的分支。

沿用运行时的项目与工作树标识、写操作互斥和受限的 LocalGit 执行器。服务端在写入前读取真实状态，以字面路径更新索引，识别重命名的两侧路径。快捷提交保留已有桌面入口并直接使用索引。文件列表拥有自己的滚动区，提交操作固定在列表下方，窄布局给文件区更多高度。

在隔离仓库检查新增文件暂存和撤销、部分暂存、重命名和提交范围。Electron 检查文件较多时的滚动与提交入口。回退时可移除索引路由和界面操作，既有索引由 Git 保管。
