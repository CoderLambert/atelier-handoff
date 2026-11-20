# 内置浏览器下载

苏州市人事考试附件声明 `target="_blank"`，第一份附件为 Excel。工作台的原生页面会拒绝自行创建系统窗口，所以需要在当前项目的浏览器中接续这些链接。

人工浏览时，将当前项目页面触发的普通 HTTP(S) 新标签请求交给当前受控网页视图，保留浏览器会话与下载来源。下载由 Electron `session` 的 `will-download` 回调负责。主进程在系统下载目录分配路径，监听字节进度、完成、取消和失败。前端在现有工具栏展示下载入口，用一个 shadcn 对话框查看近期下载和定位文件。参考 [Electron DownloadItem](https://www.electronjs.org/docs/latest/api/download-item) 与 [WebContents 窗口处理](https://www.electronjs.org/docs/latest/api/web-contents#contentssetwindowopenhandlerhandler)。

安装态用本地网站复现 `target="_blank"` 的 Excel 文件，并核对状态、重复文件名和实际落盘内容。
