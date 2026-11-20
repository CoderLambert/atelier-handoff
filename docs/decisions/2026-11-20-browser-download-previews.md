# 下载列表的文件预览和打开

下载弹窗以文件行显示名称、大小和下载状态。已完成的文件可以在桌面内预览、用系统应用打开或定位到下载目录。预览复用已有的 FileVista 组件。

由通过可信来源校验的 Electron IPC 按项目和下载标识读取已完成文件。主进程限制预览读取大小和支持类型，并按下载记录定位文件。系统打开使用 Electron 的 `shell.openPath`。参考 [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc) 与 [Electron shell](https://www.electronjs.org/docs/latest/api/shell)。

FileVista 的静态预览使用字节源。现有 `xlsx` 插件使用 ExcelJS。为覆盖本机已下载的旧 Excel 附件，采用 FileVista 自定义插件接口，以固定版本 SheetJS CE 读取 XLS 与 XLSX，并用独立 worker 解析有限的表格预览。参考 [SheetJS 安装](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/) 与项目锁定的 FileVista 插件接口。

安装态验证实际下载的工作簿、FileVista 内容渲染、原生系统打开和跨项目访问拒绝。
