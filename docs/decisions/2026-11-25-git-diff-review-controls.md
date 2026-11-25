# Git 差异阅读、文件定位与完整内容

提交详情的文件标题已经可折叠，折叠后其下还显示两处重复提示。横向文件条与差异区域的滚动轨道相邻。保留可聚焦的文件标题和一个紧凑下拉选择器，批量展开、收起与切换对比使用带说明的图标。差异区保留纵向滚动。窄侧栏打开某条提交时给差异完整宽度，关闭后恢复提交列表及键盘焦点。

参考 [VS Code diff editor](https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/widget/diffEditor/diffEditorWidget.ts) 的并排/行内选择与 [DSH diff 标签](https://github.com/cherrchen/dsh-plugin-git/blob/v0.2.14/src/client/tab-definitions.ts#L55-L72) 的比较身份。复用现有补丁解析和高亮，在左右栏对齐上下文与增删行，同时保留原布局。两层比较仍用于同时查看暂存与未暂存，左右对比用来阅读同一份差异的前后版本。

完整内容按提交 OID、索引或工作区读取。删除项保留从比较前的版本读取的入口。Git 对象限定普通文件、256 KiB 内的 UTF-8，并复用项目路径限制。系统定位使用 [Electron `showItemInFolder`](https://www.electronjs.org/docs/latest/api/shell#shellshowiteminfolderfullpath)，renderer 传项目 ID、工作树 ID 和相对路径，main 向配对运行时取得经验证的本机路径后定位文件。

用真实 Git 夹具覆盖历史、索引、工作区版本与被删除的路径，用 Electron 核对图标操作、左右对齐、完整预览和原生定位。回退使用原差异组件和文件工具入口，无数据格式变化。
